/**
 * Intel 8271 Floppy Disk Controller — the FDC the BBC Micro Model B shipped
 * with (and the one Acorn DFS 1.20 drives). Unlike the WD179x (see
 * wd179x.ts), the 8271 is a command/parameter/result phase machine: a command
 * byte is written to the command register, its parameters follow one at a time
 * to the parameter register until the count is satisfied, the chip executes,
 * and any result is read back from the result register.
 *
 *   Status / Command   (read / write)   offset 0 (FE80)
 *   Result / Parameter (read / write)   offset 1 (FE81)
 *   Reset              (write)          offset 2 (FE82)
 *   —                  (read 0xFF)      offset 3 (FE83)
 *   Data register      (read / write)   FE84
 *
 * Data moves through the data register (FE84) handshaked by DATA REQUEST: in
 * EXEC phase a byte is offered/consumed and DRQ drops until the CPU services
 * it. The BBC wires the chip's interrupt output to the CPU NMI line, so the
 * peripheral forwards the `onInterrupt` callback there.
 *
 * This is a functional (not bit-accurate) model: there is no flux or bitstream
 * layer. Disk contents come straight from the shared `DskImage` model (the
 * same structure the uPD765A and WD179x cores use), so SSD/DSD/DSK geometry
 * and sector write-back are shared with the rest of the emulator.
 *
 * Semantics follow MAME's `i8271` device (`i8271.cpp`) — status and error
 * names and values, the command-parameter table and the SPECIFY/mode handling
 * are adapted from it. MAME's i8271 is BSD-3-Clause, copyright Carl and
 * Olivier Galibert; see THIRD_PARTY.md for the notice. Register wiring, the
 * drive-status bit layout and the drive/side-select bits in the drive-output
 * (oport) register were checked against beebjit's `intel_fdc.c` as a
 * reference only; no beebjit code is used.
 */

import type { DskImage, DskSector } from '@/media/floppy/disk-image.ts';

export interface I8271Options {
  /** Interrupt output — the BBC wires this to the CPU NMI line. */
  onInterrupt?: (asserted: boolean) => void;
}

// ── Status register bits (MAME `sr_r`) ──────────────────────────────────────
const SR_BSY = 0x80; // EXEC: a command is running
const SR_CF  = 0x40; // CMD: command register full / awaiting parameters
const SR_PF  = 0x20; // parameter full (unused by this model)
const SR_RF  = 0x10; // RESULT: a result byte is available
const SR_IRQ = 0x08; // interrupt line asserted
const SR_DRQ = 0x04; // EXEC: data register needs service (only if MODER bit 0)

// ── Phases ──────────────────────────────────────────────────────────────────
const PHASE_IDLE   = 0;
const PHASE_CMD    = 1;
const PHASE_EXEC   = 2;
const PHASE_RESULT = 3;
/** A command has finished but the chip holds BUSY until the completion timer
 *  expires (BeebEm `SetTrigger`): the result/interrupt appears a few cycles
 *  later, not the instant the last parameter is written. */
const PHASE_BUSY   = 4;

/** Cycles (1 MHz disc clock) a completed command holds BUSY before its result
 *  and interrupt appear. Mirrors BeebEm's short `SetTrigger` delay. */
const COMPLETION_CYCLES = 50;

/** Cycles between successive data-register bytes of a transfer (BeebEm's
 *  TIMEBETWEENBYTES). Each tick offers the next byte and re-raises the
 *  interrupt, so the DFS's per-byte NMI handler advances its byte counter. */
const BYTE_CYCLES = 80;

// ── Result/error codes (MAME error enum) — the DFS tests these ──────────────
const ERR_NONE  = 0x00; // success
const ERR_ICRC  = 0x0c; // ID field CRC error
const ERR_DCRC  = 0x0e; // data field CRC error
const ERR_NR    = 0x10; // drive not ready
const ERR_WP    = 0x12; // write protected
const ERR_T0NF  = 0x14; // track 0 not found
const ERR_NF    = 0x1e; // record (sector) not found (BeebEm's code)

/** Status-register bit values, exported for tests and the BBC peripheral. */
export const I8271Status = {
  BSY: SR_BSY, CF: SR_CF, PF: SR_PF, RF: SR_RF, IRQ: SR_IRQ, DRQ: SR_DRQ,
} as const;

/** Result/error bytes, exported for tests and the BBC peripheral. */
export const I8271Result = {
  NONE: ERR_NONE, ICRC: ERR_ICRC, DCRC: ERR_DCRC,
  NR: ERR_NR, WP: ERR_WP, T0NF: ERR_T0NF, NF: ERR_NF,
} as const;

// ── READ DRIVE STATUS result bits (BeebEm `DoReadDriveStatusCommand`) ───────
// Result = 0x80 | (drive1 selected) | (drive0 selected) | (track0) | (wp).
// The "selected" bits double as the per-drive ready flags the DFS tests
// (drive 0 ready == 0x04), so a selected drive always reads ready.
const DS_ALWAYS        = 0x80;
const DS_DRIVE1        = 0x40; // drive 1 selected
const DS_WRITEPROT     = 0x08; // selected drive write-protected
const DS_DRIVE0        = 0x04; // drive 0 selected (== drive 0 ready)
const DS_TRACK0        = 0x02; // selected drive at track 0

// ── MODER (mode register) bits ──────────────────────────────────────────────
const MODER_NO_DMA = 0x01; // 1 = polled/NMI operation (no DMA) — the BBC way
const MODER_ALWAYS = 0xc0; // bits the chip always forces high
const MODER_DEFAULT = MODER_ALWAYS;

// ── Drive-output (oport) bits (WRITE SPECIAL REGISTER 0x23) ─────────────────
const OPORT_SELECT_MASK    = 0xc0; // drive-select override mask
const OPORT_DRIVE1_SELECT  = 0x80;
const OPORT_DRIVE0_SELECT  = 0x40;
const OPORT_SIDE           = 0x20; // 1 = side 1
const OPORT_LOAD_HEAD      = 0x08; // motor/spin control

// ── SPECIFY mode fields ─────────────────────────────────────────────────────
const SPECIFY_STEP = 0x0d; // head step/settle/timing block
const SPECIFY_BADTRACK0 = 0x10;
const SPECIFY_BADTRACK1 = 0x18;

/** Unformatted / erased sector filler. */
const FORMAT_FILLER = 0xe5;

// ── WRITE/READ SPECIAL REGISTER sub-register addresses ──────────────────────
const REG_MODER      = 0x17;
const REG_DRIVE_OUT  = 0x23;
const REG_TRACK0     = 0x12;
const REG_TRACK1     = 0x1a;
const REG_BADTRACK_0 = 0x10;
const REG_BADTRACK_1 = 0x11;
const REG_BADTRACK_2 = 0x18;
const REG_BADTRACK_3 = 0x19;

/** Command/parameter/result register offsets, expressed as FE80..FE83. */
const REG_STATUS = 0;
const REG_RESULT = 1;
const REG_RESET  = 2;

/** Reset register value that resets the chip. */
const RESET_ASSERT = 1;

/** Default single-sector transfer for the "single" read/write/verify commands. */
const SINGLE_SECTOR_COUNT = 1;

export class I8271 {
  private readonly options: I8271Options;

  constructor(options: I8271Options = {}) {
    this.options = options;
    this.reset();
  }

  // ── Command/parameter/result state ────────────────────────────────────────
  private phase = PHASE_IDLE;
  private readonly command = new Uint8Array(6);
  private commandPos = 0;
  private paramsRemaining = 0;
  private rr = 0;
  private dataReg = 0;

  // ── Interrupt / data-request lines ────────────────────────────────────────
  /** Completion interrupt (set on entering RESULT, cleared on result read). */
  private pendingIrq = false;
  /** The actual interrupt level seen by the host. */
  private irq = false;
  /** Data request: an EXEC data byte is waiting for the CPU. */
  private drq = false;

  // ── Chip configuration registers ─────────────────────────────────────────
  private moder = MODER_DEFAULT;
  private oport = 0;
  /** SPECIFY timing fields. Stored for completeness; this model runs instantly. */
  srate = 0;
  hset = 0;
  icnt = 0;
  hload = 0;

  // ── Drive state ───────────────────────────────────────────────────────────
  /** Head position per unit. */
  private readonly pcn = [0, 0];
  /** Per-unit per-bad-track cylinder numbers (SPECIFY / WRITE SPECIAL 0x1x). */
  private readonly badtrack = [[0, 0], [0, 0]];

  /** Per-unit write-protect tab. Public so the disk UI can toggle it. */
  readonly writeProtect: boolean[] = [false, false];

  /** Selected side (0/1) — from the drive-output register's side bit. */
  private side = 0;
  /** Last selected unit — for the activity LED / status readout. */
  currentDrive = 0;
  /** True from a data/seek/format command issue until its result is consumed. */
  motorOn = false;

  // ── Indicators for the host's frame probe ─────────────────────────────────
  /** A command is transferring data through the data register right now. */
  get isExecuting(): boolean { return this.phase === PHASE_EXEC; }
  /** The active EXEC transfer is a write (head writing to disk). */
  get isWriting(): boolean { return this.phase === PHASE_EXEC && this.writing; }
  /** Sector number of the in-flight command (0 when idle). */
  get currentSector(): number { return this.phase === PHASE_IDLE ? 0 : this.command[2] & 0xff; }
  /** Head position (current cylinder) of a unit. */
  getUnitTrack(unit: number): number { return this.pcn[unit & 1]; }

  // ── Disk images ───────────────────────────────────────────────────────────
  private readonly disks: (DskImage | null)[] = [null, null];
  /** Per-unit "written since insert/save" flag (drives C/D style indicator). */
  private readonly dirty = [false, false];

  // ── Active transfer ───────────────────────────────────────────────────────
  private buffer: Uint8Array | null = null;
  private bufPos = 0;
  private writing = false;
  /** Sectors the current transfer is reading from / writing to. */
  private targetSectors: DskSector[] = [];
  private transferUnit = 0;

  // ── Deferred completion ───────────────────────────────────────────────────
  /** Cycles (1 MHz) left before the pending completion is applied. */
  private delay = 0;
  /** Completion queued by a command, applied when `delay` hits zero. */
  private pending: { kind: 'result'; rr: number; interrupt: boolean } | { kind: 'idle' } | null = null;
  /** Cycles until the next EXEC byte is offered/consumed (0 when mid-transfer). */
  private byteDelay = 0;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  reset(): void {
    const wasIrq = this.irq;
    this.phase = PHASE_IDLE;
    this.command.fill(0);
    this.commandPos = 0;
    this.paramsRemaining = 0;
    this.rr = 0;
    this.dataReg = 0;
    this.pendingIrq = false;
    this.drq = false;
    this.moder = MODER_DEFAULT;
    this.oport = 0;
    this.srate = 0;
    this.hset = 0;
    this.icnt = 0;
    this.hload = 0;
    this.pcn[0] = this.pcn[1] = 0;
    this.badtrack[0] = [0, 0];
    this.badtrack[1] = [0, 0];
    this.side = 0;
    this.currentDrive = 0;
    this.motorOn = false;
    this.buffer = null;
    this.bufPos = 0;
    this.writing = false;
    this.targetSectors = [];
    this.transferUnit = 0;
    this.delay = 0;
    this.pending = null;
    this.byteDelay = 0;
    this.irq = false;
    // Deliberately do NOT drop disks or the dirty flags — a reset is not an eject.
    if (wasIrq) this.options.onInterrupt?.(false);
  }

  /** Advance the deferred-completion timer by `cycles` (1 MHz disc clock). */
  tick(cycles: number): void {
    if (this.pending !== null) {
      this.delay -= cycles;
      if (this.delay > 0) return;
      const p = this.pending;
      this.pending = null;
      this.delay = 0;
      if (p.kind === 'result') this.finishResultNow(p.rr, p.interrupt);
      else this.finishIdleNow();
      return;
    }
    // Per-byte transfer cadence: offer the next byte once its delay expires,
    // and complete once the last one has been serviced.
    if (this.phase === PHASE_EXEC && this.buffer !== null && this.byteDelay > 0) {
      this.byteDelay -= cycles;
      if (this.byteDelay > 0) return;
      this.byteDelay = 0;
      if (this.bufPos < this.buffer.length) this.setDrq(true);
      else if (this.writing) this.completeWrite();
      else this.completeTransfer();
    }
  }

  /** No-op frame hook — provided so the machine can pump the chip per frame. */
  tickFrame(): void {}

  // ── Disk management ───────────────────────────────────────────────────────

  insertDisk(image: DskImage, unit: number): void {
    const u = unit & 1;
    this.disks[u] = image;
    this.dirty[u] = false;
    this.pcn[u] = 0;
  }

  ejectDisk(unit: number): void {
    const u = unit & 1;
    this.disks[u] = null;
    this.dirty[u] = false;
  }

  getDiskImage(unit: number): DskImage | null {
    return this.disks[unit & 1];
  }

  isDirty(unit: number): boolean {
    return this.dirty[unit & 1];
  }

  clearDirty(unit: number): void {
    this.dirty[unit & 1] = false;
  }

  // ── Host register interface ───────────────────────────────────────────────

  /** offset 0..3 = FE80..FE83 (FE84 is the separate data register). */
  read(offset: number): number {
    switch (offset & 0x03) {
      case REG_STATUS: return this.status();
      case REG_RESULT: return this.readResult();
      default: return 0xff; // offset 2/3 — nothing readable
    }
  }

  write(offset: number, value: number): void {
    switch (offset & 0x03) {
      case REG_STATUS: this.writeCommand(value); break;
      case REG_RESULT: this.writeParameter(value); break;
      case REG_RESET: if ((value & 0xff) === RESET_ASSERT) this.reset(); break;
      default: break; // offset 3 is unmapped
    }
  }

  /** FE84 data register — services the active EXEC transfer. */
  readData(): number {
    if (this.phase !== PHASE_EXEC || this.buffer === null || this.writing || !this.drq) {
      return this.dataReg;
    }
    this.setDrq(false);
    const value = this.buffer[this.bufPos++];
    this.dataReg = value;
    this.byteDelay = BYTE_CYCLES;   // offer the next byte later
    return value;
  }

  writeData(value: number): void {
    this.dataReg = value & 0xff;
    if (this.phase !== PHASE_EXEC || this.buffer === null || !this.writing || !this.drq) return;
    this.setDrq(false);
    this.buffer[this.bufPos++] = value & 0xff;
    this.byteDelay = BYTE_CYCLES;   // take the next byte later
  }

  // ── Status / interrupt plumbing ───────────────────────────────────────────

  private status(): number {
    let s = this.irq ? SR_IRQ : 0;
    switch (this.phase) {
      case PHASE_CMD:
        s |= SR_CF;
        break;
      case PHASE_EXEC:
        s |= SR_BSY;
        // MAME only exposes DRQ when MODER bit 0 (no-DMA) is set.
        if ((this.moder & MODER_NO_DMA) !== 0 && this.drq) s |= SR_DRQ;
        break;
      case PHASE_BUSY:
        s |= SR_BSY;
        break;
      case PHASE_RESULT:
        s |= SR_RF;
        break;
      default:
        break;
    }
    return s;
  }

  private setDrq(state: boolean): void {
    if (state === this.drq) return;
    this.drq = state;
    this.updateInterrupt();
  }

  private setIrq(state: boolean): void {
    if (state === this.pendingIrq) return;
    this.pendingIrq = state;
    this.updateInterrupt();
  }

  /** The interrupt line is completion-IRQ OR (DRQ while no-DMA mode is set). */
  private updateInterrupt(): void {
    const level = this.pendingIrq || ((this.moder & MODER_NO_DMA) !== 0 && this.drq);
    if (level === this.irq) return;
    this.irq = level;
    this.options.onInterrupt?.(level);
  }

  // ── Command phase ─────────────────────────────────────────────────────────

  private writeCommand(value: number): void {
    if (this.phase !== PHASE_IDLE) return; // commands only start from IDLE
    const count = this.parameterCount(value);
    if (count < 0) return; // unknown first byte — ignore, stay IDLE
    this.command[0] = value & 0xff;
    this.commandPos = 1;
    this.paramsRemaining = count;
    if (count === 0) this.startCommand();
    else this.phase = PHASE_CMD;
  }

  private writeParameter(value: number): void {
    if (this.phase !== PHASE_CMD || this.commandPos >= this.command.length) return;
    this.command[this.commandPos++] = value & 0xff;
    if (--this.paramsRemaining <= 0) this.startCommand();
  }

  /** Parameter bytes expected after the command byte (MAME `check_command`). */
  private parameterCount(first: number): number {
    switch (first & 0x3f) {
      case 0x0a: case 0x0e: // write single
      case 0x12: case 0x16: // read single
      case 0x1e:            // verify single
        return 2;
      case 0x0b: case 0x0f: // write multi
      case 0x13: case 0x17: // read multi
      case 0x1f:            // verify multi
        return 3;
      case 0x1b: return 3;   // read ID
      case 0x23: return 5;   // format track
      case 0x29: return 1;   // seek / recalibrate
      case 0x2c: return 0;   // read drive status
      case 0x35: return 4;   // specify
      case 0x3a: return 2;   // write special register
      case 0x3d: return 1;   // read special register
      default:   return -1;  // invalid
    }
  }

  private startCommand(): void {
    switch (this.command[0] & 0x3f) {
      case 0x0a: case 0x0e: this.beginWrite(false); break;
      case 0x0b: case 0x0f: this.beginWrite(true); break;
      case 0x12: case 0x16: this.beginRead(false); break;
      case 0x13: case 0x17: this.beginRead(true); break;
      case 0x1e: this.beginVerify(false); break;
      case 0x1f: this.beginVerify(true); break;
      case 0x1b: this.beginReadId(); break;
      case 0x23: this.doFormat(); break;
      case 0x29: this.doSeek(); break;
      case 0x2c: this.doDriveStatus(); break;
      case 0x35: this.doSpecify(); break;
      case 0x3a: this.doWriteSpecial(); break;
      case 0x3d: this.doReadSpecial(); break;
      default: this.phase = PHASE_IDLE; break;
    }
  }

  // ── Result helpers ────────────────────────────────────────────────────────

  /** Complete a command with a result byte. The "long" commands (Seek, Read,
   *  Write, Verify, Format, Read ID) hold the chip busy for a short delay and
   *  then raise the interrupt (BeebEm's `SetTrigger`); the "simple" commands
   *  (READ DRIVE STATUS, READ SPECIAL REGISTER) return a result immediately and
   *  WITHOUT interrupting, so pass `interrupt = false, cycles = 0`. */
  private finishResult(rr: number, interrupt = true, cycles = COMPLETION_CYCLES): void {
    this.setDrq(false);
    if (cycles > 0) {
      this.pending = { kind: 'result', rr: rr & 0xff, interrupt };
      this.delay = cycles;
      this.phase = PHASE_BUSY;
      return;
    }
    this.finishResultNow(rr, interrupt);
  }

  private finishResultNow(rr: number, interrupt: boolean): void {
    this.rr = rr & 0xff;
    this.phase = PHASE_RESULT;
    this.setIrq(interrupt);
  }

  /** Finish a command that produces no result (SPECIFY / WRITE SPECIAL). */
  private finishIdle(cycles = 0): void {
    this.setDrq(false);
    if (cycles > 0) {
      this.pending = { kind: 'idle' };
      this.delay = cycles;
      this.phase = PHASE_BUSY;
      return;
    }
    this.finishIdleNow();
  }

  private finishIdleNow(): void {
    this.motorOn = false;
    this.phase = PHASE_IDLE;
  }

  private readResult(): number {
    const value = this.rr;
    if (this.phase === PHASE_RESULT) this.phase = PHASE_IDLE;
    this.motorOn = false;
    this.setIrq(false);
    return value;
  }

  // ── Command byte helpers ──────────────────────────────────────────────────

  private commandDrive(): number {
    return (this.command[0] >> 7) & 1;
  }

  private selectSide(): number {
    return this.side;
  }

  /**
   * Resolve the sector(s) a read/write/verify command refers to. Returns null
   * when the track/sector is absent (record not found). The cylinder parameter
   * indexes the image's track/side; the sector number is matched exactly, and
   * multi-sector commands walk R upward.
   */
  private locateSectors(disk: DskImage, multi: boolean): DskSector[] | null {
    const track = this.command[1] & 0xff;
    const first = this.command[2] & 0xff;
    const count = multi ? Math.max(1, this.command[3] & 0x1f) : SINGLE_SECTOR_COUNT;
    const side = this.selectSide();
    const trackObj = disk.tracks[track]?.[side] ?? null;
    if (!trackObj) return null;
    const sectors: DskSector[] = [];
    for (let i = 0; i < count; i++) {
      const r = (first + i) & 0xff;
      const sec = trackObj.sectors.find(s => s.r === r);
      if (!sec) return null;
      sectors.push(sec);
    }
    return sectors;
  }

  private static joinSectors(sectors: DskSector[]): Uint8Array {
    let total = 0;
    for (const s of sectors) total += s.data.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const s of sectors) {
      out.set(s.data, off);
      off += s.data.length;
    }
    return out;
  }

  // ── READ / WRITE / VERIFY ─────────────────────────────────────────────────

  private beginRead(multi: boolean): void {
    const unit = this.commandDrive();
    this.currentDrive = unit;
    this.transferUnit = unit;
    this.pcn[unit] = this.command[1] & 0xff;
    this.motorOn = true;

    const disk = this.disks[unit];
    if (!disk) { this.finishResult(ERR_NR); return; }
    const sectors = this.locateSectors(disk, multi);
    if (!sectors) { this.finishResult(ERR_NF); return; }

    this.targetSectors = sectors;
    this.buffer = I8271.joinSectors(sectors);
    this.bufPos = 0;
    this.writing = false;
    this.phase = PHASE_EXEC;
    this.byteDelay = BYTE_CYCLES;
  }

  private beginWrite(multi: boolean): void {
    const unit = this.commandDrive();
    this.currentDrive = unit;
    this.transferUnit = unit;
    this.pcn[unit] = this.command[1] & 0xff;
    this.motorOn = true;

    if (this.writeProtect[unit]) { this.finishResult(ERR_WP); return; }
    const disk = this.disks[unit];
    if (!disk) { this.finishResult(ERR_NR); return; }
    const sectors = this.locateSectors(disk, multi);
    if (!sectors) { this.finishResult(ERR_NF); return; }

    let total = 0;
    for (const s of sectors) total += s.data.length;
    this.targetSectors = sectors;
    this.buffer = new Uint8Array(total);
    this.bufPos = 0;
    this.writing = true;
    this.phase = PHASE_EXEC;
    this.byteDelay = BYTE_CYCLES;
  }

  private beginVerify(multi: boolean): void {
    const unit = this.commandDrive();
    this.currentDrive = unit;
    this.pcn[unit] = this.command[1] & 0xff;
    this.motorOn = true;

    const disk = this.disks[unit];
    if (!disk) { this.finishResult(ERR_NR); return; }
    if (!this.locateSectors(disk, multi)) { this.finishResult(ERR_NF); return; }
    this.finishResult(ERR_NONE);
  }

  private beginReadId(): void {
    const unit = this.commandDrive();
    this.currentDrive = unit;
    this.pcn[unit] = this.command[1] & 0xff;
    this.motorOn = true;

    const disk = this.disks[unit];
    if (!disk) { this.finishResult(ERR_NR); return; }
    const trackObj = disk.tracks[this.command[1] & 0xff]?.[this.selectSide()] ?? null;
    const id = trackObj?.sectors[0];
    if (!id) { this.finishResult(ERR_NF); return; }

    // The ID field the head encounters: cylinder, side, sector, size code.
    this.buffer = Uint8Array.from([id.c, id.h, id.r, id.n]);
    this.bufPos = 0;
    this.writing = false;
    this.phase = PHASE_EXEC;
    this.byteDelay = BYTE_CYCLES;
  }

  private completeTransfer(): void {
    this.finishResult(ERR_NONE);
  }

  private completeWrite(): void {
    const buf = this.buffer;
    if (buf) {
      let off = 0;
      for (const sec of this.targetSectors) {
        sec.data.set(buf.subarray(off, off + sec.data.length));
        sec.copies = undefined; // a real write destroys weak-bit variation
        off += sec.data.length;
      }
      this.dirty[this.transferUnit] = true;
    }
    this.finishResult(ERR_NONE);
  }

  // ── SEEK / FORMAT / READ ID (instant, no data-register handshake) ─────────

  private doSeek(): void {
    const unit = this.commandDrive();
    this.currentDrive = unit;
    this.motorOn = true;
    if (!this.disks[unit]) { this.finishResult(ERR_NR); return; }
    const target = this.command[1] & 0xff;
    this.pcn[unit] = target; // target 0 is a recalibrate; both succeed with a disk
    this.finishResult(ERR_NONE);
  }

  private doFormat(): void {
    const unit = this.commandDrive();
    this.currentDrive = unit;
    this.pcn[unit] = this.command[1] & 0xff;
    this.motorOn = true;

    if (this.writeProtect[unit]) { this.finishResult(ERR_WP); return; }
    const disk = this.disks[unit];
    if (!disk) { this.finishResult(ERR_NR); return; }
    const trackObj = disk.tracks[this.command[1] & 0xff]?.[this.selectSide()] ?? null;
    if (!trackObj) { this.finishResult(ERR_NF); return; }

    for (const sec of trackObj.sectors) sec.data.fill(FORMAT_FILLER);
    this.dirty[unit] = true;
    this.finishResult(ERR_NONE);
  }

  // ── READ DRIVE STATUS ─────────────────────────────────────────────────────

  private doDriveStatus(): void {
    const sel1 = (this.command[0] & 0x80) !== 0;
    const sel0 = (this.command[0] & 0x40) !== 0;
    const unit = sel1 ? 1 : 0;
    this.currentDrive = unit;

    let driveIn = DS_ALWAYS;
    if (sel1) driveIn |= DS_DRIVE1;
    if (sel0) driveIn |= DS_DRIVE0;
    if (this.pcn[unit] === 0) driveIn |= DS_TRACK0;
    if (this.writeProtect[unit]) driveIn |= DS_WRITEPROT;

    this.finishResult(driveIn, false, 0); // simple command — no interrupt, no delay
  }

  // ── SPECIFY / SPECIAL REGISTERS ───────────────────────────────────────────

  private doSpecify(): void {
    const mode = this.command[1];
    if (mode === SPECIFY_STEP) {
      this.srate = this.command[2];
      this.hset = this.command[3];
      this.icnt = this.command[4] >> 4;
      this.hload = this.command[4] & 0x0f;
    } else if (mode === SPECIFY_BADTRACK0 || mode === SPECIFY_BADTRACK1) {
      const unit = (mode >> 3) & 1;
      this.badtrack[unit][0] = this.command[2];
      this.badtrack[unit][1] = this.command[3];
      this.pcn[unit] = this.command[4];
    }
    this.finishIdle();
  }

  private doWriteSpecial(): void {
    const sub = this.command[1];
    const value = this.command[2];
    switch (sub) {
      case REG_MODER:
        this.moder = (value | MODER_ALWAYS) & 0xff;
        break;
      case REG_DRIVE_OUT: {
        this.oport = value & ~OPORT_SELECT_MASK;
        const sel = value & OPORT_SELECT_MASK;
        if (sel === OPORT_DRIVE0_SELECT) this.currentDrive = 0;
        else if (sel === OPORT_DRIVE1_SELECT) this.currentDrive = 1;
        this.side = (value & OPORT_SIDE) !== 0 ? 1 : 0;
        if ((value & OPORT_LOAD_HEAD) !== 0) this.motorOn = true;
        break;
      }
      case REG_TRACK0: this.pcn[0] = value; break;
      case REG_TRACK1: this.pcn[1] = value; break;
      case REG_BADTRACK_0: this.badtrack[0][0] = value; break;
      case REG_BADTRACK_1: this.badtrack[0][1] = value; break;
      case REG_BADTRACK_2: this.badtrack[1][0] = value; break;
      case REG_BADTRACK_3: this.badtrack[1][1] = value; break;
      default: break;
    }
    this.finishIdle();
  }

  private doReadSpecial(): void {
    const sub = this.command[1] & 0x3f;
    switch (sub) {
      case REG_TRACK0: this.rr = this.pcn[0]; break;
      case REG_TRACK1: this.rr = this.pcn[1]; break;
      case REG_MODER:  this.rr = this.moder; break;
      case REG_BADTRACK_0: this.rr = this.badtrack[0][0]; break;
      case REG_BADTRACK_1: this.rr = this.badtrack[0][1]; break;
      case REG_BADTRACK_2: this.rr = this.badtrack[1][0]; break;
      case REG_BADTRACK_3: this.rr = this.badtrack[1][1]; break;
      case REG_DRIVE_OUT: this.rr = ((this.command[0] & OPORT_SELECT_MASK) | this.oport) & 0xff; break;
      default: this.rr = 0; break;
    }
    this.finishResult(this.rr, false, 0); // simple command — no interrupt, no delay
  }
}
