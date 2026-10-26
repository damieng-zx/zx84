/**
 * Apple Disk II controller card (slot 6) and its drives, at the bit level.
 *
 * The card has no disk controller chip: a 16-state sequencer (the "logic state
 * sequencer", a PROM clocked at 2 MHz) moves bit cells between the drive and an
 * 8-bit data register, and software does everything else — finding address
 * fields, decoding GCR, timing its writes. So the drive is modelled as what it
 * is, a stream of bit cells per track turning past the head:
 *
 *  - Rotation. Each drive's head has a bit position on its track, advanced from
 *    the CPU cycle count: one cell every `bitTiming / 8` cycles (4 cycles for a
 *    standard 4 µs cell, since the sequencer's 2 MHz clock comes from the same
 *    crystal as the CPU). The position catches up at every access to the card
 *    from the exact cycle of that access, so it keeps turning across pauses
 *    between reads — a loader that counts cycles between bytes, or a timing
 *    check that measures a track, sees real timing.
 *  - Head. Four stepper phase magnets ($C0x0-$C0x7); the head settles at the
 *    pull of whichever magnets are on, so one magnet holds it on a whole or half
 *    track and two adjacent magnets between them on a quarter track. 160
 *    quarter-track positions map onto the disk's tracks (the WOZ TMAP); a blank
 *    one reads as noise.
 *  - Read (Q7 off, Q6 off). Each cell goes through the MC3470 read amplifier:
 *    after more than three cells without a flux transition its gain has risen
 *    far enough that noise reads as random bits (about 30% ones), which is what
 *    some protections check for. The bits shift into the data register; once
 *    its top bit is set the byte is complete and held through 0 cells, and the
 *    next 1 cell clears it one cell later, so a completed byte stays readable
 *    for at least two cells (8 cycles), long enough for a 7-cycle
 *    `LDA $C08C,X / BPL` loop to see it.
 *  - Sense write protect (Q7 off, Q6 on). The register shifts right with the
 *    write-protect switch fed into the top, twice per CPU cycle; a read of
 *    $C0xE then has bit 7 set on a protected disk.
 *  - Write (Q7 on). A CPU write while Q6 is on loads the register; every cell
 *    the head writes its top bit to the track (1 = flux transition) and shifts
 *    it left. Software that reloads every 32 cycles writes 8-cell bytes; every
 *    40 cycles, 10-cell self-sync bytes.
 *
 * Reads of any of the card's addresses return the data register. The model is
 * behavioural, not the sequencer's PROM: where within its 4 µs a cell is
 * sampled is not modelled.
 */

import type { DskImage } from '@/media/floppy/disk-image.ts';
import {
  APPLE2_BIT_TIMING, APPLE2_NO_TRACK, APPLE2_QUARTER_TRACKS, APPLE2_TIMING_UNITS_PER_CYCLE,
  APPLE2_TRACK_BITS, blankBitTrack, type Apple2BitTrack,
} from '@/media/floppy/apple2-bitstream.ts';
import { foldApple2Track, nibblizeApple2Disk, type Apple2Disk } from '@/media/floppy/apple2-media.ts';
import { APPLE2_CPU_CLOCK } from '../constants.ts';

const MOTOR_OFF = 0x08;
const MOTOR_ON = 0x09;
/** The controller card keeps the drive running for about a second after a
 *  motor-off access (a one-shot timer on the card), so the disk is still
 *  rotating when a following read begins. Loaders that switch the motor off
 *  between sectors and then test for rotation depend on it. */
const MOTOR_OFF_DELAY_CYCLES = APPLE2_CPU_CLOCK;
const DRIVE1 = 0x0A;
const DRIVE2 = 0x0B;
const Q6_OFF = 0x0C;
const Q6_ON = 0x0D;
const Q7_OFF = 0x0E;
const Q7_ON = 0x0F;

const MAX_QUARTER_TRACK = APPLE2_QUARTER_TRACKS - 1;

/** Fixed seed of the MC3470 noise generator, so runs are repeatable. */
const NOISE_SEED = 0x2545F491;

export class Disk2 {
  private readonly disks: (Apple2Disk | null)[] = [null, null];
  readonly writeProtect = [false, false];
  /** Track slots written since the last fold, per drive. */
  private readonly dirtyTracks: Set<number>[] = [new Set(), new Set()];
  private readonly wrote = [false, false];

  /** Per-drive head position in quarter tracks (0 = track 0, 4 = track 1). */
  private readonly quarterTrack = [0, 0];
  /** Per-drive bit position on the track under the head. */
  private readonly bitPos = [0, 0];
  /** Per-drive length of the revolution `bitPos` counts in (the track under the
   *  head, or the last one when the head is over a blank quarter track). */
  private readonly revolution = [APPLE2_TRACK_BITS, APPLE2_TRACK_BITS];
  /** The stepper magnets that are on (bit n = phase n); the card drives the
   *  selected drive's stepper. */
  private phases = 0;
  private currentDrive = 0;
  /** Motor state as commanded by $C0E8/$C0E9. */
  private motor = false;
  /** CPU cycle at which a commanded motor-off takes effect; -1 = none pending. */
  private motorOffAt = -1;

  // The card's one data path.
  private q6 = false;
  private q7 = false;
  /** The data register, as the CPU reads it. */
  private reg = 0;
  /** A 1 cell arrived while a byte was held: the register restarts next cell. */
  private restart = false;
  /** The last four cells off the head (MC3470 noise window). */
  private window = 0;
  private noise = NOISE_SEED;
  /** CPU cycle the drive has been turned to, and the timing units carried
   *  past the last whole cell. */
  private lastCycles = 0;
  private units = 0;
  /** The track under the selected drive's head (null: blank or no disk). */
  private track: Apple2BitTrack | null = null;
  private trackSlot = -1;

  /** `cpuCycles(write)` gives the CPU cycle of the bus access in progress (or
   *  the current count outside one). */
  constructor(private readonly cpuCycles: (write?: boolean) => number) {}

  // ── Media ──────────────────────────────────────────────────────────────

  /** Put a disk in a drive. A plain sector `DskImage` is nibblized (in place)
   *  into bit tracks first. */
  insertDisk(image: DskImage, unit: number): void {
    if (unit === this.currentDrive) this.catchUp(this.cpuCycles());
    const disk = nibblizeApple2Disk(image);
    this.disks[unit] = disk;
    this.writeProtect[unit] = disk.apple2.bits.writeProtected;
    this.dirtyTracks[unit].clear();
    this.wrote[unit] = false;
    this.bitPos[unit] = 0;
    if (unit === this.currentDrive) this.selectTrack();
  }

  ejectDisk(unit: number): void {
    if (unit === this.currentDrive) this.catchUp(this.cpuCycles());
    this.flush(unit);
    this.disks[unit] = null;
    this.dirtyTracks[unit].clear();
    this.wrote[unit] = false;
    this.writeProtect[unit] = false;
    if (this.currentDrive === unit) { this.motor = false; this.motorOffAt = -1; this.selectTrack(); }
  }

  getDiskImage(unit: number): Apple2Disk | null { return this.disks[unit]; }

  /** Set a drive's write-protect switch (and the disk's tab, for formats that
   *  record it). */
  setWriteProtect(unit: number, on: boolean): void {
    this.writeProtect[unit] = on;
    const disk = this.disks[unit];
    if (disk) disk.apple2.bits.writeProtected = on;
  }

  isDirty(unit: number): boolean { return this.wrote[unit]; }

  get hasPendingWrites(): boolean {
    return this.dirtyTracks[0].size > 0 || this.dirtyTracks[1].size > 0;
  }

  clearDirty(unit: number): void { this.wrote[unit] = false; }

  reset(): void {
    this.motor = false;
    this.motorOffAt = -1;
    this.currentDrive = 0;
    this.phases = 0;
    this.q6 = false;
    this.q7 = false;
    this.reg = 0;
    this.restart = false;
    this.window = 0;
    this.wrote[0] = this.wrote[1] = false;
    this.lastCycles = this.cpuCycles();
    this.units = 0;
    this.selectTrack();
  }

  /** Whether the drive is physically rotating: commanded on, or commanded off
   *  but still inside the card's spin-down delay. */
  private get spinning(): boolean {
    if (!this.motor) return false;
    if (this.motorOffAt >= 0) {
      const now = this.cpuCycles();
      // A CPU reset rewinds the cycle count; treat that as the delay expiring.
      if (now >= this.motorOffAt || now < this.motorOffAt - MOTOR_OFF_DELAY_CYCLES) return false;
    }
    return true;
  }

  // ── Switch decode ──────────────────────────────────────────────────────

  read(offset: number): number {
    this.catchUp(this.cpuCycles(false));
    this.applySwitch(offset & 0x0F);
    return this.reg;
  }

  write(offset: number, val: number): void {
    this.catchUp(this.cpuCycles(true));
    this.applySwitch(offset & 0x0F);
    // In write-load mode the register takes what the CPU puts on the bus.
    if (this.q7 && this.q6) this.reg = val & 0xFF;
  }

  private applySwitch(offset: number): void {
    if (offset < MOTOR_OFF) {
      const bit = 1 << (offset >> 1);
      const phases = offset & 1 ? this.phases | bit : this.phases & ~bit;
      if (phases !== this.phases) {
        this.phases = phases;
        this.moveHead();
      }
      return;
    }
    switch (offset) {
      case MOTOR_OFF:
        if (this.motor && this.motorOffAt < 0) this.motorOffAt = this.cpuCycles() + MOTOR_OFF_DELAY_CYCLES;
        break;
      case MOTOR_ON: this.motor = true; this.motorOffAt = -1; break;
      case DRIVE1: if (this.currentDrive !== 0) { this.currentDrive = 0; this.selectTrack(); } break;
      case DRIVE2: if (this.currentDrive !== 1) { this.currentDrive = 1; this.selectTrack(); } break;
      case Q6_OFF: this.q6 = false; break;
      case Q6_ON: this.q6 = true; break;
      case Q7_OFF: this.q7 = false; break;
      case Q7_ON: this.q7 = true; break;
      default: break;
    }
  }

  /**
   * Settle the selected drive's head under the magnets that are on. Magnet n
   * pulls toward quarter tracks 2n, 2n + 8, ... (phase 0 holds whole tracks
   * 0, 2, 4..., phase 1 the half tracks between them, and so on); each one
   * pulls by its offset from the head, the head moves by the average pull, and
   * a magnet exactly opposite (four quarter tracks away) pulls both ways and
   * is ignored. So one magnet centres the head on its own position and two
   * adjacent ones hold it between them — the quarter tracks some protections use.
   */
  private moveHead(): void {
    if (this.phases === 0) return;
    const unit = this.currentDrive;
    const pos = this.quarterTrack[unit];
    let sum = 0;
    let n = 0;
    for (let p = 0; p < 4; p++) {
      if (!(this.phases & (1 << p))) continue;
      let d = (2 * p - pos) & 7;          // 0..7 quarter tracks ahead
      if (d === 4) continue;              // directly opposite: no net pull
      if (d > 4) d -= 8;
      sum += d;
      n++;
    }
    if (n === 0) return;
    let next = pos + Math.round(sum / n);
    next = next < 0 ? 0 : next > MAX_QUARTER_TRACK ? MAX_QUARTER_TRACK : next;
    if (next === pos) return;
    this.quarterTrack[unit] = next;
    this.selectTrack();
  }

  /** Look up the track under the selected drive's head, keeping the head's
   *  angular position when the track's length differs. */
  private selectTrack(): void {
    const unit = this.currentDrive;
    const disk = this.disks[unit];
    const slot = disk ? disk.apple2.bits.tmap[this.quarterTrack[unit]] : APPLE2_NO_TRACK;
    const track = disk && slot !== APPLE2_NO_TRACK ? disk.apple2.bits.tracks[slot] ?? null : null;
    this.track = track;
    this.trackSlot = track ? slot : -1;
    if (track && track.bitCount !== this.revolution[unit]) {
      this.bitPos[unit] = Math.floor(this.bitPos[unit] * track.bitCount / this.revolution[unit]) % track.bitCount;
      this.revolution[unit] = track.bitCount;
    }
  }

  // ── Rotation and the data path ──────────────────────────────────────────

  /** Turn the selected drive to CPU cycle `now`, running the sequencer for
   *  every cell that passed in the mode the card was in. */
  private catchUp(now: number): void {
    const last = this.lastCycles;
    if (now <= last) {
      if (now < last) {
        // A CPU reset rewound the cycle count: start counting again from here,
        // and let any pending spin-down lapse.
        this.lastCycles = now;
        this.units = 0;
        if (this.motorOffAt >= 0) { this.motor = false; this.motorOffAt = -1; }
      }
      return;
    }
    this.lastCycles = now;
    if (!this.motor) return;
    let end = now;
    if (this.motorOffAt >= 0 && now >= this.motorOffAt) {
      end = this.motorOffAt > last ? this.motorOffAt : last;
      this.motor = false;
      this.motorOffAt = -1;
    }
    const cycles = end - last;
    if (cycles <= 0) return;
    if (this.q6 && !this.q7) this.senseWriteProtect(cycles);
    const timing = this.disks[this.currentDrive]?.apple2.bits.bitTiming ?? APPLE2_BIT_TIMING;
    this.units += cycles * APPLE2_TIMING_UNITS_PER_CYCLE;
    const cells = Math.floor(this.units / timing);
    this.units -= cells * timing;
    if (cells > 0) this.clockCells(cells);
  }

  /** Sense mode: the register shifts right twice a cycle, filling with the
   *  write-protect switch. */
  private senseWriteProtect(cycles: number): void {
    const fill = this.writeProtect[this.currentDrive] ? 0xFF : 0x00;
    const steps = cycles * 2;
    this.reg = steps >= 8 ? fill : ((this.reg >> steps) | (fill << (8 - steps))) & 0xFF;
    this.restart = false;
  }

  /** One MC3470 noise bit: a 1 about 30% of the time. */
  private nextNoise(): number {
    let x = this.noise;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.noise = x >>> 0;
    return (x & 0x0F) < 5 ? 1 : 0;
  }

  private clockCells(cells: number): void {
    const unit = this.currentDrive;
    const len = this.revolution[unit];
    if (this.q7) { this.writeCells(cells); return; }
    let pos = this.bitPos[unit];
    if (this.q6) { this.bitPos[unit] = (pos + cells) % len; return; }

    // Read. After a long time away, only the last revolution or so matters.
    if (cells > 2 * len) {
      const skip = cells - len - (cells % len);
      pos = (pos + skip) % len;
      cells -= skip;
    }
    const data = this.track?.data;
    let reg = this.reg;
    let restart = this.restart;
    let win = this.window;
    for (let i = 0; i < cells; i++) {
      const raw = data !== undefined ? (data[pos >> 3] >> (7 - (pos & 7))) & 1 : 0;
      if (++pos >= len) pos = 0;
      win = ((win << 1) | raw) & 0x0F;
      const bit = win !== 0 ? (win >> 1) & 1 : this.nextNoise();
      if (restart) { reg = 0x02 | bit; restart = false; }
      else if (reg & 0x80) { if (bit) restart = true; }
      else reg = (reg << 1) | bit;
    }
    this.reg = reg;
    this.restart = restart;
    this.window = win;
    this.bitPos[unit] = pos;
  }

  private writeCells(cells: number): void {
    const unit = this.currentDrive;
    const disk = this.disks[unit];
    const writable = disk !== null && !this.writeProtect[unit];
    if (writable && !this.track) this.formatBlankPosition(disk);
    const len = this.revolution[unit];
    let pos = this.bitPos[unit];
    let reg = this.reg;
    const data = writable && this.track ? this.track.data : null;
    // Holding write mode for over a revolution overwrites the whole track.
    if (cells > 2 * len) cells = len + (cells % len);
    for (let i = 0; i < cells; i++) {
      if (data) {
        const mask = 0x80 >> (pos & 7);
        if (reg & 0x80) data[pos >> 3] |= mask; else data[pos >> 3] &= ~mask;
      }
      if (++pos >= len) pos = 0;
      reg = (reg << 1) & 0xFF;
    }
    this.reg = reg;
    this.bitPos[unit] = pos;
    if (data) {
      this.dirtyTracks[unit].add(this.trackSlot);
      this.wrote[unit] = true;
    }
  }

  /** Writing over a blank quarter track lays down a new, empty track there. */
  private formatBlankPosition(disk: Apple2Disk): void {
    const bits = disk.apple2.bits;
    const slot = bits.tracks.length;
    if (slot >= APPLE2_NO_TRACK) return;
    bits.tracks.push(blankBitTrack(this.revolution[this.currentDrive]));
    bits.tmap[this.quarterTrack[this.currentDrive]] = slot;
    this.selectTrack();
  }

  /** Fold one drive's written tracks into its sector view. */
  private flush(unit: number): void {
    const dirty = this.dirtyTracks[unit];
    const disk = this.disks[unit];
    if (dirty.size === 0 || !disk) return;
    for (const slot of dirty) foldApple2Track(disk, slot);
    dirty.clear();
  }

  /** Bring a drive's sector view up to date with its writes now (before a save). */
  flushWrites(unit: number): void {
    if (unit === this.currentDrive) this.catchUp(this.cpuCycles());
    this.flush(unit);
  }

  /** Once per frame: fold any written tracks back into the mounted images. */
  tickFrame(): void {
    this.flush(0);
    this.flush(1);
  }

  // ── Frame-probe indicators ─────────────────────────────────────────────

  get motorOn(): boolean {
    return this.spinning && this.disks[this.currentDrive] !== null;
  }
  get isExecuting(): boolean { return this.motorOn; }
  get isWriting(): boolean { return this.q7 && this.motorOn; }
  get currentDriveIndex(): number { return this.currentDrive; }
  /** The whole track nearest the drive's head. */
  getUnitTrack(unit: number): number {
    return this.disks[unit] ? (this.quarterTrack[unit] + 1) >> 2 : 0;
  }
  /** The drive's head position in quarter tracks. */
  getUnitQuarterTrack(unit: number): number { return this.quarterTrack[unit]; }
}
