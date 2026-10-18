/**
 * Apple Disk II controller card (slot 6).
 *
 * The card is a bit-level device: software drives the stepper, selects a drive,
 * and then shifts a GCR bit stream one bit at a time through a shift register,
 * deciding for itself where sector headers are (see the $C600 boot ROM). This
 * models exactly that:
 *
 *  - sixteen soft switches at the slot's $C0x0-$C0xF window (stepper phases,
 *    motor, drive select, the Q6/Q7 mode flip-flops);
 *  - a shift register clocked from the CPU cycle count at the drive's bit rate,
 *    latching each completed byte;
 *  - reads of the data register ($C0EC) returning the last latched byte (bit 7
 *    set; 0 when no byte has arrived since the previous read).
 *
 * Each read advances the register by the bits that elapsed since the last one
 * (a disk bit every {@link CYCLES_PER_BIT} CPU cycles), but never more than a
 * byte's worth. The cap is what keeps the framing exact: software that pauses
 * between reads (to process a sector, say) would otherwise let the bit
 * position run far ahead and skip a whole byte, which desynchronises the
 * byte-oriented reader. Capping holds the drive's bit position roughly still
 * across such pauses, which is invisible to DOS/ProDOS; only flux-level copy
 * protection could tell the difference.
 *
 * Logical `.dsk`-class images are 6-and-2 encoded into nibble tracks on mount;
 * writes patch bits back into those tracks and are decoded into the image again
 * as it settles. The two drives keep independent media and head positions.
 */

import type { DskImage, DskTrack } from '@/media/floppy/disk-image.ts';
import {
  APPLE2_DEFAULT_VOLUME, APPLE2_SECTORS_PER_TRACK, APPLE2_TRACK_NIBBLES, apple2VolumeNumber,
  decodeTrack, encodeTrack,
} from '@/media/floppy/apple2.ts';
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
const Q6_ON = 0x0D;
const Q7_OFF = 0x0E;
const Q7_ON = 0x0F;
const DATA = 0x0C;

/** CPU cycles per disk bit at 300 RPM: 6656 nibbles × 8 bits per revolution. */
const CYCLES_PER_BIT = (APPLE2_CPU_CLOCK * 0.2) / (APPLE2_TRACK_NIBBLES * 8);

export class Disk2 {
  private readonly images: (DskImage | null)[] = [null, null];
  /** Encoded nibble stream per drive, per track (filled lazily). */
  private readonly encoded: (Uint8Array | null)[][] = [[], []];
  private readonly dirtyTracks: Set<number>[] = [new Set(), new Set()];
  private readonly wrote = [false, false];
  readonly writeProtect = [false, false];
  /** Address-field volume number per drive (from the disk's VTOC when it has one). */
  private readonly volume = [APPLE2_DEFAULT_VOLUME, APPLE2_DEFAULT_VOLUME];

  /** Per-drive head position, in half-track steps (two steps = one track). */
  private readonly halfTrack = [0, 0];
  private readonly phase = [0, 0];
  private currentDrive = 0;
  /** Motor state as commanded by $C0E8/$C0E9. */
  private motor = false;
  /** CPU cycle at which a commanded motor-off takes effect; -1 = none pending. */
  private motorOffAt = -1;

  // Shift-register / rotation state (shared: the card has one data path).
  private bitPos = 0;
  private shiftReg = 0;
  private symbol = 0;
  private q7 = false;
  private cyclesAccum = 0;
  private lastCycles = 0;

  constructor(private readonly cpuCycles: () => number) {}

  // ── Media ──────────────────────────────────────────────────────────────

  insertDisk(image: DskImage, unit: number): void {
    this.images[unit] = image;
    this.volume[unit] = apple2VolumeNumber(image);
    this.encoded[unit] = [];
    this.dirtyTracks[unit].clear();
    this.wrote[unit] = false;
    this.halfTrack[unit] = 0;
    this.phase[unit] = 0;
    // The rotation state is the card's shared data path: only restart it when
    // the mounted drive is the one under the head, so mounting the other drive
    // mid-transfer doesn't drop a half-read byte.
    if (unit === this.currentDrive) {
      this.symbol = 0;
      this.shiftReg = 0;
      this.bitPos = 0;
      this.rebase();
    }
  }

  ejectDisk(unit: number): void {
    this.images[unit] = null;
    this.encoded[unit] = [];
    this.dirtyTracks[unit].clear();
    this.wrote[unit] = false;
    this.writeProtect[unit] = false;
    if (this.currentDrive === unit) { this.motor = false; this.motorOffAt = -1; }
  }

  getDiskImage(unit: number): DskImage | null { return this.images[unit]; }

  isDirty(unit: number): boolean { return this.wrote[unit]; }

  get hasPendingWrites(): boolean {
    return this.dirtyTracks[0].size > 0 || this.dirtyTracks[1].size > 0;
  }

  clearDirty(unit: number): void { this.wrote[unit] = false; }

  reset(): void {
    this.motor = false;
    this.motorOffAt = -1;
    this.currentDrive = 0;
    this.halfTrack[0] = this.halfTrack[1] = 0;
    this.phase[0] = this.phase[1] = 0;
    this.bitPos = 0;
    this.shiftReg = 0;
    this.symbol = 0;
    this.q7 = false;
    this.wrote[0] = this.wrote[1] = false;
    this.rebase();
  }

  /** Anchor the rotation clock so a mount/rebuild doesn't consume the whole
   *  elapsed time since power-on as one huge bit burst. */
  private rebase(): void {
    this.lastCycles = this.cpuCycles();
    this.cyclesAccum = 0;
  }

  /** Whether the drive is physically rotating: commanded on, or commanded off
   *  but still inside the card's spin-down delay. */
  private get spinning(): boolean {
    if (!this.motor) return false;
    if (this.motorOffAt >= 0) {
      const now = this.cpuCycles();
      // A CPU reset rewinds the cycle count; treat that as the delay expiring.
      if (now >= this.motorOffAt || now < this.motorOffAt - MOTOR_OFF_DELAY_CYCLES) {
        this.motor = false;
        this.motorOffAt = -1;
        return false;
      }
    }
    return true;
  }

  // ── Switch decode ──────────────────────────────────────────────────────

  read(offset: number): number {
    switch (offset & 0x0F) {
      case DATA: return this.readData();
      case Q6_ON: return this.writeProtect[this.currentDrive] ? 0x80 : 0x00;
      case Q7_OFF: this.q7 = false; return this.writeProtect[this.currentDrive] ? 0x80 : 0x00;
      case Q7_ON: this.q7 = true; return 0x00;
      default: this.applySwitch(offset & 0x0F); return 0x00;
    }
  }

  write(offset: number, val: number): void {
    switch (offset & 0x0F) {
      case DATA: return;
      case Q6_ON: if (this.q7) this.writeByte(val & 0xFF); return;
      case Q7_OFF: this.q7 = false; return;
      case Q7_ON: this.q7 = true; return;
      default: this.applySwitch(offset & 0x0F); return;
    }
  }

  private applySwitch(offset: number): void {
    if (offset < MOTOR_OFF) {
      if (offset & 1) this.stepPhase(offset >> 1);
      return;
    }
    switch (offset) {
      case MOTOR_OFF:
        if (this.motor && this.motorOffAt < 0) this.motorOffAt = this.cpuCycles() + MOTOR_OFF_DELAY_CYCLES;
        break;
      case MOTOR_ON: this.motor = true; this.motorOffAt = -1; break;
      case DRIVE1: this.currentDrive = 0; break;
      case DRIVE2: this.currentDrive = 1; break;
      default: break;
    }
  }

  /** A stepper phase magnet energised: two steps advance the head one track. */
  private stepPhase(phase: number): void {
    const unit = this.currentDrive;
    if (phase === this.phase[unit]) return;
    const delta = (phase - this.phase[unit] + 4) & 3;
    let pos = this.halfTrack[unit];
    if (delta === 1) pos += 1;
    else if (delta === 3) pos -= 1;
    else return;                                    // a two-step jump is ambiguous
    const max = Math.max(0, (this.maxTracks(unit) - 1) * 2);
    this.halfTrack[unit] = pos < 0 ? 0 : pos > max ? max : pos;
    this.phase[unit] = phase;
  }

  private maxTracks(unit: number): number { return this.images[unit]?.numTracks ?? 0; }

  private trackIndex(unit: number): number {
    const t = Math.floor(this.halfTrack[unit] / 2);
    const max = this.maxTracks(unit) - 1;
    return t > max ? max : t < 0 ? 0 : t;
  }

  // ── Shift register ─────────────────────────────────────────────────────

  /** One read of the data register clocks in the bits that have elapsed since
   *  the last read (capped at one byte's worth, so no byte is ever skipped) and
   *  returns the latched byte once — 0 while no byte has completed. */
  private readData(): number {
    if (this.spinning && this.images[this.currentDrive]) {
      const now = this.cpuCycles();
      let elapsed = now - this.lastCycles;
      if (elapsed < 0) elapsed = 0;              // CPU reset rewinds tStates
      this.lastCycles = now;
      this.cyclesAccum += elapsed;
      let bits = Math.floor(this.cyclesAccum / CYCLES_PER_BIT);
      if (bits > 8) { bits = 8; this.cyclesAccum = 0; } else { this.cyclesAccum -= bits * CYCLES_PER_BIT; }

      const track = this.nibbles(this.currentDrive, this.trackIndex(this.currentDrive));
      if (track) {
        for (let i = 0; i < bits; i++) {
          const nib = track[(this.bitPos >> 3) % APPLE2_TRACK_NIBBLES];
          const bit = (nib >> (7 - (this.bitPos & 7))) & 1;
          this.bitPos = (this.bitPos + 1) % (APPLE2_TRACK_NIBBLES * 8);
          this.shiftReg = ((this.shiftReg << 1) | bit) & 0xFF;
          if (this.shiftReg & 0x80) { this.symbol = this.shiftReg; this.shiftReg = 0; }
        }
      }
    }
    const v = this.symbol;
    this.symbol = 0;
    return v;
  }

  private writeByte(val: number): void {
    const unit = this.currentDrive;
    if (!this.spinning || !this.images[unit] || this.writeProtect[unit]) return;
    const trackIndex = this.trackIndex(unit);
    const track = this.nibbles(unit, trackIndex);
    if (!track) return;
    for (let i = 0; i < 8; i++) {
      const bit = (val >> (7 - i)) & 1;
      const index = (this.bitPos >> 3) % APPLE2_TRACK_NIBBLES;
      const mask = 1 << (7 - (this.bitPos & 7));
      track[index] = bit ? (track[index] | mask) : (track[index] & ~mask);
      this.bitPos = (this.bitPos + 1) % (APPLE2_TRACK_NIBBLES * 8);
    }
    this.dirtyTracks[unit].add(trackIndex);
    this.wrote[unit] = true;
  }

  /** Encode (once) and return the nibble stream for a drive's track. */
  private nibbles(unit: number, trackIndex: number): Uint8Array | null {
    const image = this.images[unit];
    if (!image || trackIndex < 0 || trackIndex >= image.numTracks) return null;
    let track = this.encoded[unit][trackIndex];
    if (track) return track;
    const dsk = image.tracks[trackIndex]?.[0] ?? null;
    if (!dsk) return null;
    track = encodeTrack(this.sectorsOf(dsk), trackIndex, this.volume[unit]);
    this.encoded[unit][trackIndex] = track;
    return track;
  }

  private sectorsOf(track: DskTrack): (Uint8Array | null)[] {
    const sectors: (Uint8Array | null)[] = new Array(APPLE2_SECTORS_PER_TRACK).fill(null);
    for (const s of track.sectors) {
      if (s.r >= 0 && s.r < APPLE2_SECTORS_PER_TRACK) sectors[s.r] = s.data;
    }
    return sectors;
  }

  /** Once per frame: fold any written tracks back into the mounted images. */
  tickFrame(): void {
    for (let unit = 0; unit < 2; unit++) {
      const dirty = this.dirtyTracks[unit];
      const image = this.images[unit];
      if (dirty.size === 0 || !image) continue;
      for (const trackIndex of dirty) {
        const track = this.encoded[unit][trackIndex];
        const dsk = image.tracks[trackIndex]?.[0];
        if (!track || !dsk) continue;
        const sectors = decodeTrack(track);
        for (const s of dsk.sectors) {
          const data = sectors[s.r];
          if (data) s.data.set(data);
        }
      }
      dirty.clear();
    }
  }

  // ── Frame-probe indicators ─────────────────────────────────────────────

  get motorOn(): boolean {
    return this.spinning && this.images[this.currentDrive] !== null;
  }
  get isExecuting(): boolean { return this.motorOn; }
  get isWriting(): boolean { return this.q7 && this.motorOn; }
  get currentDriveIndex(): number { return this.currentDrive; }
  getUnitTrack(unit: number): number {
    return this.images[unit] ? this.trackIndex(unit) : 0;
  }
}
