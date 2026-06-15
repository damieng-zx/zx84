/**
 * uPD765A Floppy Disk Controller emulation.
 *
 * Used in the ZX Spectrum +3/+2A. Two I/O ports:
 *   0x2FFD (read):  Main Status Register
 *   0x3FFD (r/w):   Data Register (command params in, result bytes out)
 *
 * Implements the full command set. Without a loaded disk image,
 * seek/recalibrate succeed but read/write/format return "not ready."
 */

import type { DskImage, DskSector, DskTrack } from '@/plus3/dsk.ts';

// ── Command codes (lower 5 bits of command byte) ────────────────────────

const CMD_READ_TRACK    = 0x02;
const CMD_SPECIFY       = 0x03;
const CMD_SENSE_DRIVE   = 0x04;
const CMD_WRITE_DATA    = 0x05;
const CMD_READ_DATA     = 0x06;
const CMD_RECALIBRATE   = 0x07;
const CMD_SENSE_INT     = 0x08;
const CMD_WRITE_DELETED = 0x09;
const CMD_READ_ID       = 0x0A;
const CMD_READ_DELETED  = 0x0C;
const CMD_FORMAT_TRACK  = 0x0D;
const CMD_SEEK          = 0x0F;
const CMD_VERSION       = 0x10;
const CMD_SCAN_EQUAL    = 0x11;
const CMD_SCAN_LOW_EQ   = 0x19;
const CMD_SCAN_HIGH_EQ  = 0x1D;

// ── Status Register 0 bit masks ─────────────────────────────────────────

/** Interrupt code: abnormal termination */
const ST0_ABNORMAL = 0x40;
/** Interrupt code: invalid command */
const ST0_INVALID  = 0x80;
/** Seek completed */
const ST0_SEEK_END = 0x20;
/** Drive not ready */
const ST0_NOT_READY = 0x08;

// ── Phase enum ──────────────────────────────────────────────────────────

const enum Phase { Idle, Command, Execution, Result }

// ── Parameter counts per command (bytes after command byte) ─────────────

function paramCount(cmdByte: number): number {
  switch (cmdByte & 0x1F) {
    case CMD_READ_TRACK:
    case CMD_READ_DATA: case CMD_READ_DELETED:
    case CMD_WRITE_DATA: case CMD_WRITE_DELETED:
    case CMD_SCAN_EQUAL: case CMD_SCAN_LOW_EQ: case CMD_SCAN_HIGH_EQ:
      return 8;
    case CMD_FORMAT_TRACK:
      return 5;
    case CMD_READ_ID: case CMD_RECALIBRATE: case CMD_SENSE_DRIVE:
      return 1;
    case CMD_SPECIFY: case CMD_SEEK:
      return 2;
    case CMD_SENSE_INT: case CMD_VERSION:
      return 0;
    default:
      return 0; // invalid — execute immediately
  }
}

export class UPD765A {
  // ── Debug logging ───────────────────────────────────────────────────

  /** Inject a log sink. Defaults to null (silent); set a function (e.g. console.log) to enable. */
  logFn: ((...args: any[]) => void) | null = null;

  private log(...args: any[]): void {
    this.logFn?.('[FDC]', ...args);
  }

  // ── Phase & buffers ─────────────────────────────────────────────────

  private phase = Phase.Idle;
  private cmdBuf: number[] = [];
  private cmdExpected = 0;
  private resBuf: number[] = [];
  private resPos = 0;

  // ── Interrupt latch (consumed by Sense Interrupt Status) ────────────

  private intPending = false;
  private intST0 = 0;
  private intPCN = 0;

  // ── Per-drive state ─────────────────────────────────────────────────

  private pcn = [0, 0, 0, 0]; // Present Cylinder Number

  // Specify parameters are accepted and discarded (mechanical timing).

  /** Motor on/off — set externally via port 0x1FFD bit 3 */
  motorOn = false;

  // ── Disk image ─────────────────────────────────────────────────────

  private disks: (DskImage | null)[] = [null, null, null, null];

  /** Per-drive write-protect flag (software-controlled, like a physical tab) */
  writeProtect = [false, false, false, false];

  /**
   * Per-drive "force ready" flag.  When set, Sense Drive Status always
   * reports the drive as ready (ST3 bit 5 = 1) even with no disk inserted.
   * Used to keep the +3 ROM from remapping B: to a swap-A on boot.
   */
  forceReady = [false, false, false, false];

  /**
   * Set to the unit number (0/1) when FORMAT_TRACK finishes; cleared by the
   * UI layer after it refreshes disk metadata.  -1 = no pending refresh.
   */
  formattedUnit = -1;

  /** Per-drive Read ID cycling index */
  private idIndex = [0, 0, 0, 0];

  /**
   * Per-drive "flipped side" offset for combined flippy disks (a single DSK
   * holding two independent single-sided 180K sides — a 3" disk you turn over).
   * 0 = Side A (head 0 → image side 0), 1 = Side B (head 0 → image side 1).
   * The +3's drive is single-sided hardware, so it only ever selects head 0;
   * this offset re-points that head at the other stored side, exactly as
   * physically turning the disk over would. Always 0 for ordinary disks.
   */
  flipSide = [0, 0, 0, 0];

  /**
   * Per-drive "written since insert" flag, indexed by physical unit (0/1).
   * Set when a sector write or format mutates the image, cleared on
   * insert/eject and when the modified image is saved. The UI lights the
   * drive's Save button when this is set, so the user knows there are changes
   * worth downloading (we don't persist in-session writes back to the file).
   */
  dirty = [false, false];

  // ── Latched state for UI display (execution completes within one frame) ──

  private latchR = 0;
  private latchHead = 0;
  private latchWriting = false;
  /** Counts down each frame — shows last op briefly after execution ends */
  private latchFrames = 0;

  /**
   * One-off latch: set to the masked SCAN opcode (0x11/0x19/0x1D) when an
   * unimplemented SCAN command is issued, so the UI can raise a visible notice.
   * The frame bridge reads it and clears it back to -1 after displaying.
   * -1 = nothing pending.
   */
  unsupportedScan = -1;

  // ── Execution phase state ──────────────────────────────────────────

  private exBuf: Uint8Array = new Uint8Array(0);
  private exPos = 0;
  private exWriting = false;
  /** True if executing Read Track (read entire track, don't advance sectors) */
  private exReadTrack = false;
  /** Current sector R value being read/written */
  private exR = 0;
  /** End-of-track R value */
  private exEOT = 0;
  private exHitEOT = false;
  /**
   * MT (Multi-Track) bit from the command. When set, reaching EOT on the
   * starting head continues the same command on the other side of the cylinder
   * instead of terminating — End of Cylinder is only reported after the second
   * head also reaches EOT.
   */
  private exMT = false;
  /**
   * SK (Skip) bit from the command, Read Data/Read Deleted Data only. When
   * set, a sector whose address-mark type doesn't match the command (a
   * Deleted-AM sector under READ_DATA, or a normal-AM sector under
   * READ_DELETED) is skipped entirely — not transferred, not a termination
   * point — and the search continues at R+1. SK=0 (the pre-existing,
   * still-default behaviour) instead reads that sector and terminates
   * after it (see the non-final CM-mismatch comment in advanceSector).
   */
  private exSK = false;
  private exAbnormal = false;
  /** Command parameters preserved for multi-sector and result phase */
  private exUnit = 0;
  private exHead = 0;
  private exC = 0;
  private exH = 0;
  private exN = 0;
  private exCmdN = 0;    // N from the command (may differ from sector ID's N)
  private exCmd = 0;     // Masked command (READ_DATA vs READ_DELETED) — for command-relative CM
  /** Reference to current track for write-back */
  private exTrack: DskTrack | null = null;
  /** Status registers from sector (for CRC error reporting) */
  private exST1 = 0;
  private exST2 = 0;
  /**
   * True when the starting sector's C field doesn't match the physical cylinder.
   * These are copy-protection tracks — real hardware can't find sector R+1 after
   * reading R because disk rotation timing prevents it. Limit to one sector/command.
   */
  private exSingleSector = false;
  /**
   * Consecutive MSR reads while in execution phase without a data read.
   * The real uPD765A triggers OVERRUN (ST1 bit 4) when the CPU doesn't read
   * data fast enough. Protection code deliberately breaks the INI loop mid-sector
   * then polls MSR waiting for execution phase to end — overrun makes it end.
   * ~32 consecutive status polls without a data read is a safe threshold.
   */
  private exOverrunPolls = 0;
  private static readonly OVERRUN_THRESHOLD = 32;

  // ── Format-track execution state ────────────────────────────────────

  /** True when executing FORMAT_TRACK (CPU feeds sector IDs, not data) */
  private exFormatting = false;
  /** Sectors per cylinder received in FORMAT_TRACK command */
  private exSC = 0;
  /** Gap 3 length from FORMAT_TRACK command */
  private exGPL = 0;
  /** Filler byte from FORMAT_TRACK command */
  private exFiller = 0;

  // ── Public API ─────────────────────────────────────────────────────

  /** Expose disk image for BIOS trap handler (drive A: only for compatibility). */
  get diskImage(): DskImage | null { return this.disks[0]; }

  /** Get disk image for a specific drive unit. */
  getDiskImage(unit: number): DskImage | null {
    return this.disks[unit & 3];
  }

  /** Set the Present Cylinder Number for a drive (used by BIOS trap seek). */
  setTrack(unit: number, cyl: number): void { this.pcn[unit & 3] = cyl; }

  /** Latch sector access info for UI display (used by BIOS trap read/write). */
  latchAccess(r: number, head: number, writing: boolean): void {
    this.latchR = r;
    this.latchHead = head;
    this.latchWriting = writing;
    this.latchFrames = 25;
  }

  insertDisk(image: DskImage, unit: number = 0): void {
    this.disks[unit & 3] = image;
    this.idIndex[unit & 3] = 0;
    this.flipSide[unit & 3] = 0;   // a freshly inserted disk always starts Side A
    this.dirty[unit & 1] = false;  // a freshly inserted image has no unsaved writes
    this.log(`🎮 Disk inserted in unit ${unit}: ${image.numTracks} tracks, ${image.numSides} sides, ${image.format} format`);
    if (image.protection && image.protection !== 'None') {
      this.log(`   🔒 Copy protection detected: ${image.protection}`);
    }
    if (image.diskFormat) {
      this.log(`   📀 Disk format: ${image.diskFormat}`);
    }
  }

  ejectDisk(unit: number = 0): void {
    this.log(`📤 Disk ejected from unit ${unit}`);
    this.disks[unit & 3] = null;
    this.flipSide[unit & 3] = 0;
    this.dirty[unit & 1] = false;
  }

  /** True if the disk in `unit` has been written to since it was inserted/saved. */
  isDirty(unit: number): boolean { return this.dirty[this.physUnit(unit)]; }

  /** Clear the dirty flag — called once the modified image has been saved. */
  clearDirty(unit: number): void { this.dirty[this.physUnit(unit)] = false; }

  // ── State getters (for UI) ──────────────────────────────────────────

  get currentUnit(): number { return this.exUnit; }

  get currentTrack(): number { return this.pcn[this.physUnit(this.exUnit)]; }

  getUnitTrack(unit: number): number { return this.pcn[this.physUnit(unit)]; }

  /**
   * Resolve logical drive unit to physical drive index.
   * On the +3 only 2 drive-select lines are wired: units 2/3 alias to 0/1.
   * This matches FUSE's specplus3.c: drive[2]=drive[0], drive[3]=drive[1].
   */
  private physUnit(unit: number): number { return unit & 1; }

  get currentSector(): number {
    if (this.phase === Phase.Execution) return this.exR;
    return this.latchFrames > 0 ? this.latchR : 0;
  }

  get currentHead(): number {
    if (this.phase === Phase.Execution) return this.exHead;
    return this.latchFrames > 0 ? this.latchHead : 0;
  }

  get isExecuting(): boolean {
    return this.phase === Phase.Execution || this.latchFrames > 0;
  }

  get isWriting(): boolean {
    if (this.phase === Phase.Execution) return this.exWriting;
    return this.latchFrames > 0 ? this.latchWriting : false;
  }

  /** Call once per frame to decay the latched display state. */
  tickFrame(): void {
    if (this.latchFrames > 0) this.latchFrames--;
  }

  // ── Main Status Register (port 0x2FFD read) ────────────────────────

  /**
   * MSR bits:
   *   7  RQM   — 1 = data register ready for CPU access
   *   6  DIO   — 0 = CPU→FDC (write), 1 = FDC→CPU (read)
   *   5  EXM   — 1 = execution phase in progress
   *   4  CB    — 1 = command in progress
   *  3-0 D0–D3 — individual drive seek-in-progress flags
   */
  readStatus(): number {
    switch (this.phase) {
      case Phase.Idle:      return 0x80; // RQM
      case Phase.Command:   return 0x90; // RQM + CB
      case Phase.Execution: {
        // Overrun detection: real uPD765A terminates execution phase (ST1.OR)
        // when the CPU stops reading data and only polls status instead.
        // Protection code intentionally breaks its INI loop mid-sector, then
        // polls MSR waiting for execution phase to end — overrun ends it.
        if (++this.exOverrunPolls >= UPD765A.OVERRUN_THRESHOLD) {
          this.exOverrunPolls = 0;
          this.exST1 |= 0x10; // ST1 bit 4 = OR (Over Run)
          this.finishExecution();
          return 0xD0; // now in result phase
        }
        // RQM + EXM + CB, DIO depends on read vs write
        return this.exWriting ? 0xB0 : 0xF0; // write: RQM+EXM+CB, read: RQM+DIO+EXM+CB
      }
      case Phase.Result:    return 0xD0; // RQM + DIO + CB
    }
  }

  // ── Data Register (port 0x3FFD) ────────────────────────────────────

  /** Read data register — returns next result byte or execution data. */
  readData(): number {
    if (this.phase === Phase.Execution && !this.exWriting) {
      this.exOverrunPolls = 0; // CPU is still reading — reset overrun counter
      return this.readExecution();
    }
    if (this.phase !== Phase.Result) return 0xFF;
    const val = this.resBuf[this.resPos++];
    if (this.resPos >= this.resBuf.length) this.phase = Phase.Idle;
    return val;
  }

  /** Write data register — feeds command/parameter bytes or execution data. */
  writeData(val: number): void {
    if (this.phase === Phase.Execution && this.exWriting) {
      this.exOverrunPolls = 0; // CPU is still writing — reset overrun counter
      this.writeExecution(val);
      return;
    }
    if (this.phase === Phase.Result || this.phase === Phase.Execution) return;

    if (this.phase === Phase.Idle) {
      this.cmdBuf = [val];
      this.cmdExpected = paramCount(val);
      if (this.cmdExpected === 0) {
        this.exec();
      } else {
        this.phase = Phase.Command;
      }
    } else {
      this.cmdBuf.push(val);
      if (this.cmdBuf.length > this.cmdExpected) this.exec();
    }
  }

  // ── Execution phase data transfer ─────────────────────────────────

  private readExecution(): number {
    if (this.exPos >= this.exBuf.length) return 0xFF;
    const val = this.exBuf[this.exPos++];
    if (this.exPos >= this.exBuf.length) {
      if (this.exReadTrack) {
        // Read Track: entire track buffer exhausted, finish
        this.finishExecution();
      } else {
        // Read Data: current sector exhausted, try next sector
        if (!this.advanceSector()) {
          this.finishExecution();
        }
      }
    }
    return val;
  }

  private writeExecution(val: number): void {
    if (this.exPos >= this.exBuf.length) return;
    this.exBuf[this.exPos++] = val;
    if (this.exPos >= this.exBuf.length) {
      if (this.exFormatting) {
        this.finishFormat();
      } else {
        // Write buffer back to disk image
        this.writeBackSector();
        if (!this.advanceSector()) {
          this.finishExecution();
        }
      }
    }
  }

  /**
   * Try to advance to the next sector (R+1). Returns false if at EOT or
   * if the next sector can't be found. Sets exHitEOT so finishExecution()
   * can report the correct ST0/ST1 flags.
   */
  private advanceSector(): boolean {
    // Copy-protection tracks: sector.c ≠ physical cylinder. Real hardware can't
    // find the next sector due to rotation timing — stop after one sector.
    if (this.exSingleSector) {
      this.exHitEOT = true;
      return false;
    }

    // The sector just read may itself terminate a multi-sector read BEFORE EOT —
    // the real uPD765A stops AT that sector and does not read on to R+1. Only
    // applies to reads (writes stream through; mirrors finishExecution's CRC
    // rule) and only before EOT (the last sector falls through to the
    // End-of-Cylinder path below, which is the pre-existing behaviour).
    //   • Data CRC error (ST1.DE / ST2.DD) → abnormal termination (ST0 IC=01).
    //   • Control Mark — DDAM mark mismatched the command (ST2.CM, SK=0) →
    //     normal termination with CM reported, NO End-of-Cylinder.
    // exST1/exST2 here are this sector's command-relative flags (set by
    // cmdReadWrite for the first sector, by sectorReadFlags below for the rest —
    // so a matching-DDAM multi-sector read clears CM uniformly: the Speedlock
    // probe READ_DELETED over all-DDAM sectors reports ST2=0x00, as on hardware).
    //
    // NOTE: a *non-final* control mark is reported here as a NORMAL termination.
    // This is a deliberate choice. One behavioural reference (FUSE) flags it
    // abnormal when EOT > R; we don't mirror its implementation, and here we
    // diverge knowingly — no documented +3 protection exercises a non-final mark
    // mismatch in a multi-sector read (every protection mark-mismatch check is
    // single-sector and terminates via the EOT path below, and every
    // multi-sector read is over *matching* marks). Absent a hardware-verified
    // case, keep the simpler normal termination rather than chase an edge flag.
    if (!this.exWriting && this.exR < this.exEOT) {
      if ((this.exST1 & 0x20) || (this.exST2 & 0x20)) {
        this.exAbnormal = true;
        return false;
      }
      if (this.exST2 & 0x40) {
        return false;
      }
    }

    this.exR++;
    if (this.exR > this.exEOT) {
      // MT (Multi-Track): on reaching EOT on the starting head, continue the
      // same command on the other side of the cylinder, restarting the sector
      // count at the command's first R. Only head 0→1 is valid (there is no
      // head 2); a single-sided disk has no side-1 track, so getTrack() returns
      // null and we fall through to the normal End-of-Cylinder termination.
      if (this.exMT && this.exHead === 0) {
        const side1 = this.getTrack(this.exUnit, 1);
        // Real uPD765A restarts the sector count at sector 1 on the new side,
        // not the command's original starting R — the two only coincide by
        // accident on disks that happen to start numbering at 1. SK applies
        // here too: skip forward past any mark-mismatched sector 1.
        const found1 = side1 ? this.findSectorForCommand(side1, 1, this.exEOT, this.exCmd) : null;
        if (side1 && found1) {
          this.exHead = 1;
          this.exTrack = side1;
          this.exR = found1.r;
          const s = found1.sector;
          this.exBuf = this.exWriting
            ? new Uint8Array(128 << this.exCmdN)
            : this.prepareReadBuffer(s);
          this.exPos = 0;
          this.exC = s.c;
          this.exH = s.h;
          this.exN = s.n;
          const f = this.sectorReadFlags(s, this.exCmd, this.exCmdN);
          this.exST1 = f.st1;
          this.exST2 = f.st2;
          if (f.abnormal) this.exAbnormal = true;
          return true;
        }
      }
      this.exR--;
      this.exHitEOT = true;
      return false;
    }

    const track = this.exTrack;
    if (!track) return false;

    // SK (Skip): search forward from here for a mark-matching sector rather
    // than accepting whatever's at exR outright (see findSectorForCommand).
    const found = this.findSectorForCommand(track, this.exR, this.exEOT, this.exCmd);
    if (!found) {
      this.exR--;
      this.exST1 |= 0x04;
      this.exAbnormal = true;
      return false;
    }
    this.exR = found.r;

    const sector = found.sector;
    if (this.exWriting) {
      this.exBuf = new Uint8Array(128 << this.exCmdN);
      this.exPos = 0;
    } else {
      this.exBuf = this.prepareReadBuffer(sector);
      this.exPos = 0;
    }

    // Update CHRN and status registers from the new sector's ID field, applying
    // the same command-relative flag rules as the first sector.
    this.exC = sector.c;
    this.exH = sector.h;
    this.exN = sector.n;
    const flags = this.sectorReadFlags(sector, this.exCmd, this.exCmdN);
    this.exST1 = flags.st1;
    this.exST2 = flags.st2;
    if (flags.abnormal) this.exAbnormal = true;

    return true;
  }

  /**
   * Prepare sector data for reading.
   *
   * Rule: return exactly (128 << physN) bytes, where physN is the sector's own
   * N field (the physical data field size on disk).
   * - cmdN is used only to detect undersized sectors (sector.n < cmdN); it
   *   does NOT expand the transfer to cmdN bytes.  On real hardware the FDC
   *   CRC-terminates after the physical sector bytes and the execution phase
   *   ends there — no extra bytes are pushed into the DMA buffer.
   * - Short sector (data.length < 128 << sector.n): fill tail with random data.
   * - Weak/CRC-error flag (st2 & 0x20): randomise all returned data.
   */
  private prepareReadBuffer(sector: DskSector): Uint8Array {
    // Physical transfer size is always determined by the sector's own N field.
    // Undersized sectors (sector.n < cmdN) only affect status reporting in
    // cmdReadWrite — the number of bytes transferred here is always physSize.
    const physSize = 128 << sector.n;

    // Simon Owen v5 multi-copy weak sector: the DSK parser populated
    // `copies` with K real reads of the same sector. Pick one at random
    // so successive reads expose the actual weak-bit variations.
    if (sector.copies && sector.copies.length > 1) {
      const pick = sector.copies[Math.floor(Math.random() * sector.copies.length)];
      // Each copy is exactly physSize bytes by construction in the
      // parser, but defend against externally-mutated DskSectors.
      if (pick.length >= physSize) return pick.subarray(0, physSize);
      const buf = new Uint8Array(physSize);
      buf.set(pick);
      for (let i = pick.length; i < physSize; i++) buf[i] = Math.floor(Math.random() * 256);
      return buf;
    }

    // Short sector: fewer bytes stored than the N field claims.
    // Deliver real bytes then pad the remainder with random data.
    if (sector.data.length < physSize) {
      const buf = new Uint8Array(physSize);
      buf.set(sector.data);
      for (let i = sector.data.length; i < physSize; i++) buf[i] = Math.floor(Math.random() * 256);
      return buf;
    }

    // Data-CRC-error flag (ST2 bit 5 = DD). A *weak* sector (Speedlock) carries
    // DD alone and must read differently each pass → randomise it so the
    // loader's double-read-and-compare sees variation.
    //
    // DD together with CM (ST2 bit 6, deleted-data address mark) is NOT weak:
    // it is a deliberately bad-CRC sector whose data is *stable and meaningful*.
    // Hexagon (unsigned) reads such a sector and uses its bytes as a decryption
    // key — randomising it corrupts the key and the loader decrypts to garbage
    // and reboots. Return the real bytes; the CRC error is still reported via
    // ST1/ST2 (and forces abnormal termination in finishExecution).
    if ((sector.st2 & 0x20) && !(sector.st2 & 0x40)) {
      return this.randomizeSector(sector.data.subarray(0, physSize));
    }

    // Normal sector — return exactly physSize bytes
    return sector.data.subarray(0, physSize);
  }

  /** Create a copy of sector data with ~10% random byte variations. */
  private randomizeSector(data: Uint8Array): Uint8Array {
    const buf = new Uint8Array(data.length);
    buf.set(data);
    const numToRandomize = Math.max(1, Math.floor(buf.length * 0.1));
    for (let i = 0; i < numToRandomize; i++) {
      const pos = Math.floor(Math.random() * buf.length);
      buf[pos] = Math.floor(Math.random() * 256);
    }
    return buf;
  }

  /** Write the execution buffer back into the current sector's data. */
  private writeBackSector(): void {
    const track = this.exTrack;
    if (!track) return;
    const idx = track.sectorMap.get(this.exR);
    if (idx === undefined) return;
    // Replace the sector's data array entirely.  The write buffer is sized by
    // the command's N parameter, which may differ from the sector ID's N (e.g.
    // protection sectors).  Using .set() would throw RangeError when exBuf is
    // larger, or leave stale tail bytes when smaller.  Replacing the array
    // ensures read-back via prepareReadBuffer() sees exactly what was written.
    track.sectors[idx].data = new Uint8Array(this.exBuf);
    // Writing destroys the v5 weak-bit state: subsequent reads must
    // return the freshly-written data, not random older copies.
    track.sectors[idx].copies = undefined;
    this.dirty[this.physUnit(this.exUnit)] = true;
  }

  /** End execution phase with result. Sets EN + abnormal termination if EOT was reached. */
  private finishExecution(): void {
    // Every execution-phase termination (normal, overrun, abnormal) passes
    // through here — the format flag must not outlive the command, or the
    // next WRITE_DATA completion would be misrouted into finishFormat().
    this.exFormatting = false;
    let st0 = (this.exHead << 2) | this.exUnit;
    let st1 = this.exST1;
    if (this.exHitEOT) {
      // Real uPD765A signals abnormal termination + End of Cylinder when
      // the sector counter passes EOT. The data was read/written fine —
      // this just means "no more sectors". Many protection schemes
      // (Alkatraz, Speedlock) check for exactly ST0=0x40 / ST1=0x80.
      st0 |= ST0_ABNORMAL;
      st1 |= 0x80;  // EN (End of Cylinder)
    }
    if (this.exAbnormal) {
      st0 |= ST0_ABNORMAL;
    }
    // Data/ID CRC error (ST1.DE 0x20 or ST2.DD 0x20) is an abnormal
    // termination on the real uPD765A: the interrupt code IC=01 sets ST0
    // bit 6. Fuse's upd_fdc.c does exactly this for READ_DATA:
    //   status_register[1] |= CRC_ERROR; status_register[2] |= DATA_ERROR;
    //   status_register[0] |= ST0_INT_ABNORM;
    // Without it the loader sees ST0=0x00 (clean read) on a sector that is
    // *supposed* to error, and the protection check fails. Hexagon (unsigned)
    // reads its N6 CRC-flagged sector and requires this; writes never set it.
    if (!this.exWriting && ((st1 & 0x20) || (this.exST2 & 0x20))) {
      st0 |= ST0_ABNORMAL;
    }
    // Overrun (ST1.OR, bit 4) is an abnormal termination (IC=01) on the real
    // uPD765A — the CPU failed to service the data register in time.
    if (st1 & 0x10) {
      st0 |= ST0_ABNORMAL;
    }
    // Return actual ST1 and ST2 from the sector (preserves CRC errors!)
    // Speedlock checks for intentional CRC errors - must not "fix" them!
    this.log(`  ← Result: ST0=0x${st0.toString(16).padStart(2, '0')} ST1=0x${st1.toString(16).padStart(2, '0')} ST2=0x${this.exST2.toString(16).padStart(2, '0')} C=${this.exC} H=${this.exH} R=${this.exR} N=${this.exN}`);
    if ((st1 & ~0x80) || this.exST2) {
      this.log(`  ⚠ CRC/Error flags present in result!`);
    }
    this.result([st0, st1, this.exST2, this.exC, this.exH, this.exR, this.exN]);
  }

  // ── Command dispatch ───────────────────────────────────────────────

  private exec(): void {
    const cmd = this.cmdBuf[0] & 0x1F;
    const cmdName = this.getCommandName(cmd);
    this.log(`CMD: ${cmdName} (0x${cmd.toString(16).padStart(2, '0').toUpperCase()})`,
             `params=[${this.cmdBuf.slice(1).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);

    switch (cmd) {
      case CMD_SPECIFY:       this.cmdSpecify(); break;
      case CMD_SENSE_DRIVE:   this.cmdSenseDrive(); break;
      case CMD_SENSE_INT:     this.cmdSenseInt(); break;
      case CMD_RECALIBRATE:   this.cmdRecalibrate(); break;
      case CMD_SEEK:          this.cmdSeek(); break;
      case CMD_READ_TRACK:    this.cmdReadTrack(); break;
      case CMD_READ_DATA:     // fall through
      case CMD_READ_DELETED:  this.cmdReadWrite(); break;
      case CMD_WRITE_DATA:    // fall through
      case CMD_WRITE_DELETED: this.cmdReadWrite(); break;
      case CMD_READ_ID:       this.cmdReadID(); break;
      case CMD_FORMAT_TRACK:  this.cmdFormat(); break;
      case CMD_SCAN_EQUAL:    // fall through
      case CMD_SCAN_LOW_EQ:   // fall through
      case CMD_SCAN_HIGH_EQ:  this.cmdUnsupportedScan(); break;
      case CMD_VERSION:       this.cmdVersion(); break;
      default:                this.cmdInvalid(); break;
    }
  }

  private getCommandName(cmd: number): string {
    switch (cmd) {
      case CMD_READ_TRACK: return 'READ_TRACK';
      case CMD_SPECIFY: return 'SPECIFY';
      case CMD_SENSE_DRIVE: return 'SENSE_DRIVE';
      case CMD_WRITE_DATA: return 'WRITE_DATA';
      case CMD_READ_DATA: return 'READ_DATA';
      case CMD_RECALIBRATE: return 'RECALIBRATE';
      case CMD_SENSE_INT: return 'SENSE_INT';
      case CMD_WRITE_DELETED: return 'WRITE_DELETED';
      case CMD_READ_ID: return 'READ_ID';
      case CMD_READ_DELETED: return 'READ_DELETED';
      case CMD_FORMAT_TRACK: return 'FORMAT_TRACK';
      case CMD_SEEK: return 'SEEK';
      case CMD_VERSION: return 'VERSION';
      case CMD_SCAN_EQUAL: return 'SCAN_EQUAL';
      case CMD_SCAN_LOW_EQ: return 'SCAN_LOW_EQ';
      case CMD_SCAN_HIGH_EQ: return 'SCAN_HIGH_EQ';
      default: return 'UNKNOWN';
    }
  }

  // ── Command implementations ────────────────────────────────────────

  /** Specify — set mechanical timing. No result phase. */
  private cmdSpecify(): void {
    // Parameters accepted and discarded — we don't model mechanical timing
    this.phase = Phase.Idle;
  }

  /** Sense Drive Status — report ST3. */
  private cmdSenseDrive(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;
    // ST3: track 0 if pcn==0, two-side=1
    const phys = this.physUnit(unit);
    let st3 = unit | (head << 2) | 0x08; // bit 3 = two-side (unit kept for ST3 drive bits)
    if (this.pcn[phys] === 0) st3 |= 0x10; // Track 0
    if (this.disks[phys] || this.forceReady[phys]) st3 |= 0x20; // bit 5 = ready
    if (this.writeProtect[phys]) st3 |= 0x40; // bit 6 = write protected
    this.result([st3]);
  }

  /** Sense Interrupt Status — return latched interrupt info. */
  private cmdSenseInt(): void {
    if (this.intPending) {
      this.intPending = false;
      this.result([this.intST0, this.intPCN]);
    } else {
      this.result([ST0_INVALID]);
    }
  }

  /** Recalibrate — seek to track 0. Generates interrupt. */
  private cmdRecalibrate(): void {
    const unit = this.cmdBuf[1] & 0x03;
    this.log(`  → Unit=${unit} recalibrating to track 0`);
    this.pcn[this.physUnit(unit)] = 0;
    this.intPending = true;
    // HD (ST0 bit 2) is intentionally 0 here — the seek-complete ST0 reports
    // head 0 regardless of the command's HDS bit (matches +3 hardware; SEEK and
    // RECALIBRATE both behave this way). The HDS is not latched into the seek
    // interrupt status.
    this.intST0 = ST0_SEEK_END | unit;
    this.intPCN = 0;
    this.phase = Phase.Idle;
  }

  /** Seek — move to specified cylinder. Generates interrupt. */
  private cmdSeek(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const ncn = this.cmdBuf[2];
    this.log(`  → Unit=${unit} seeking to cylinder ${ncn}`);
    this.pcn[this.physUnit(unit)] = ncn;
    this.intPending = true;
    // HD (ST0 bit 2) stays 0 even when the command's HDS bit selects side 1 —
    // the seek-complete ST0 reports head 0 regardless (matches +3 hardware; see
    // cmdRecalibrate). Software polls SE + unit after a seek, never HD.
    this.intST0 = ST0_SEEK_END | unit;
    this.intPCN = ncn;
    this.phase = Phase.Idle;
  }

  /** Look up the track at the current head position. */
  private getTrack(unit: number, head: number): DskTrack | null {
    const phys = this.physUnit(unit);
    const disk = this.disks[phys];
    if (!disk) return null;
    const cyl = this.pcn[phys];
    if (cyl >= disk.numTracks) return null;
    const side = head + this.flipSide[phys];
    if (side >= disk.numSides) return null;
    return disk.tracks[cyl][side];
  }

  /**
   * Compute the ST1/ST2 a sector contributes to a read result, and whether it
   * is an abnormal (unreadable) termination. Shared by cmdReadWrite (the first
   * sector) and advanceSector (every subsequent sector) so a multi-sector read
   * handles all its sectors' error/mark flags identically — otherwise only the
   * first sector got the careful treatment and the rest were taken raw.
   *
   * CRC ERROR SUPPORT (critical for Speedlock): sectors with intentional CRC
   * errors must return their proper error status — never "fixed" to 0.
   *
   * EXCEPTION — undersized protection sectors (sector.n < command N): written
   * with DDAM on the original disk; standard DSK copiers capture CRC status
   * unreliably and may store spurious DE/DD bits, so clear them to match a
   * genuine DDAM read-without-error. (Doesn't affect Speedlock/Alkatraz, where
   * sector.n == cmdN.)
   *
   * SUB-EXCEPTION — undersized *bad-CRC weak* sector (NOT DDAM): undersized +
   * genuine data-CRC error + normal address mark = a deliberately unreadable
   * protection sector (e.g. Ocean's good/bad pairing). A real uPD765A cannot
   * complete the oversized read: it reports No Data / abnormal termination. Keep
   * the sector's own error bits rather than stripping them.
   *
   * Control Mark (CM, ST2 bit 6) is reported *relative to the command*: set when
   * the sector's address-mark type mismatches what the command expects
   * (READ_DATA over a DDAM sector, or READ_DELETED over a normal-AM sector).
   */
  private sectorReadFlags(sector: DskSector, cmd: number, cmdN: number): { st1: number; st2: number; abnormal: boolean } {
    // EN (ST1 bit 7, End of Cylinder) is a controller-generated termination
    // flag — finishExecution() raises it dynamically when a read passes EOT. It
    // is never an intrinsic property of a recorded sector, but some dumpers
    // capture it into the SIB anyway (e.g. the first/last sector of a flippy
    // disk's second side). Mask it off so a stored EN can't masquerade as a
    // read error and make +3DOS reject an otherwise valid disk.
    const storedSt1 = sector.st1 & ~0x80;
    const undersized = sector.n < cmdN;
    const unreadableWeak = undersized
      && ((storedSt1 & 0x20) || (sector.st2 & 0x20))
      && !(sector.st2 & 0x40);
    if (unreadableWeak) {
      return { st1: storedSt1 | 0x04, st2: sector.st2, abnormal: true }; // ND — read fails
    }
    let st1 = undersized ? 0 : storedSt1;
    let st2 = undersized ? 0 : sector.st2;
    if (!undersized) {
      const sectorHasDDAM = !!(sector.st2 & 0x40);
      const cmdExpectsDDAM = (cmd === CMD_READ_DELETED || cmd === CMD_WRITE_DELETED);
      if (sectorHasDDAM === cmdExpectsDDAM) st2 &= ~0x40; // mark matches — clear CM
      else st2 |= 0x40;                                    // mismatch — set CM
    }
    return { st1, st2, abnormal: false };
  }

  /** True if the sector's address-mark type doesn't match what a Read
   *  Data/Read Deleted Data command expects (used by the SK skip search). */
  private markMismatches(sector: DskSector, cmd: number): boolean {
    const sectorHasDDAM = !!(sector.st2 & 0x40);
    const cmdExpectsDDAM = cmd === CMD_READ_DELETED;
    return sectorHasDDAM !== cmdExpectsDDAM;
  }

  /**
   * Find the sector to read starting at R, honouring SK (Skip). With SK=0
   * (default), the sector at R is returned regardless of mark match — a
   * mismatch there is reported and terminates the command elsewhere (see
   * advanceSector's non-final CM comment). With SK=1, a mismatched sector is
   * skipped over (not returned, not a termination point) and the search
   * continues at R+1 up to EOT. Returns null if no usable sector is found.
   */
  private findSectorForCommand(track: DskTrack, startR: number, eot: number, cmd: number)
      : { r: number; sector: DskSector } | null {
    let r = startR;
    for (;;) {
      const idx = track.sectorMap.get(r);
      if (idx === undefined) return null;
      const sector = track.sectors[idx];
      if (!this.exSK || !this.markMismatches(sector, cmd)) return { r, sector };
      if (r >= eot) return null;
      r++;
    }
  }

  /**
   * Read Data / Write Data / Read Deleted / Write Deleted / Scan.
   * No disk → abnormal termination + not ready.
   * With disk → enter execution phase for data transfer.
   */
  private cmdReadWrite(): void {
    const cmd = this.cmdBuf[0] & 0x1F;
    const mt = (this.cmdBuf[0] & 0x80) !== 0; // Multi-Track (bit 7, unmasked)
    const sk = (this.cmdBuf[0] & 0x20) !== 0; // Skip (bit 5) — Read Data/Read Deleted only
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;
    const c = this.cmdBuf[2], h = this.cmdBuf[3];
    const r = this.cmdBuf[4], n = this.cmdBuf[5];
    const eot = this.cmdBuf[6];
    const isWrite = cmd === CMD_WRITE_DATA || cmd === CMD_WRITE_DELETED;
    this.exSK = sk && !isWrite;

    this.log(`  → Unit=${unit} Head=${head} C=${c} H=${h} R=${r} N=${n} (${128 << n} bytes) EOT=${eot}`);

    const track = this.getTrack(unit, head);

    if (!track) {
      // No disk or no track — abnormal termination (NR detected before execution,
      // so ST1/ST2 must be 0x00; MA flag only valid after attempting a read)
      this.log(`  ✗ No disk or track not found (C=${c}, H=${h})`);
      const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
      this.result([st0, 0x00, 0x00, c, h, r, n]);
      return;
    }

    // Find starting sector by R value — skipping mark-mismatched sectors
    // first if SK is set (see findSectorForCommand).
    const found = this.findSectorForCommand(track, r, eot, cmd);
    if (!found) {
      // Sector not found — No Data
      this.log(`  ✗ Sector R=${r} not found on track`);
      const st0 = ST0_ABNORMAL | (head << 2) | unit;
      this.result([st0, 0x04, 0x00, c, h, r, n]); // ST1=ND (bit 2)
      return;
    }
    const { r: foundR, sector } = found;

    this.log(`  ✓ Found sector: actual size=${sector.data.length} bytes, ST1=0x${sector.st1.toString(16).padStart(2, '0')} ST2=0x${sector.st2.toString(16).padStart(2, '0')}`);

    // Write-protected disk — reject with ST1 NW (Not Writeable)
    if (isWrite && this.writeProtect[this.physUnit(unit)]) {
      this.log(`  ✗ Write rejected — drive ${unit} is write-protected`);
      const st0 = ST0_ABNORMAL | (head << 2) | unit;
      this.result([st0, 0x02, 0x00, c, h, r, n]); // ST1=NW (bit 1)
      return;
    }

    // Save execution state — C, H, N come from the sector's own ID field,
    // not the command parameters. The real uPD765A reports the last sector's
    // actual CHRN in its result bytes, which may differ from the command's
    // CHRN (e.g. copy-protection sectors with mismatched cylinder fields).
    this.exUnit = unit;
    this.exHead = head;
    this.exC = sector.c;
    this.exH = sector.h;
    this.exN = sector.n;  // From sector ID (may differ from command N)
    this.exR = foundR;
    this.exEOT = eot;
    this.exHitEOT = false;
    this.exMT = mt;
    this.exAbnormal = false;
    this.exTrack = track;
    this.exWriting = isWrite;
    this.exReadTrack = false; // Reading individual sectors, not raw track
    this.exOverrunPolls = 0;

    // Latch for UI display (execution completes within one frame)
    this.latchR = foundR;
    this.latchHead = head;
    this.latchWriting = isWrite;
    this.latchFrames = 25; // ~0.5s at 50fps

    this.exCmdN = n;  // Command N — controls transfer size (may differ from sector ID N)
    this.exCmd = cmd; // for command-relative CM in advanceSector

    if (isWrite) {
      this.exBuf = new Uint8Array(128 << n);
      this.exPos = 0;
    } else {
      this.exBuf = this.prepareReadBuffer(sector);
      this.exPos = 0;
    }

    // Capture this sector's error/mark flags for the result. The undersized /
    // unreadable-weak / command-relative-CM rules (and their Speedlock/Ocean/
    // Alkatraz rationale) live on sectorReadFlags(), shared with advanceSector
    // so every sector of a multi-sector read is handled identically.
    const flags = this.sectorReadFlags(sector, cmd, n);
    this.exST1 = flags.st1;
    this.exST2 = flags.st2;
    if (flags.abnormal) this.exAbnormal = true;

    // COPY-PROTECTION SINGLE-SECTOR MODE:
    // If the sector's C field doesn't match the physical cylinder, this is a
    // copy-protection track. On real hardware, disk rotation timing prevents the
    // FDC from finding sector R+1 after reading R on such tracks — the head is
    // positioned at the wrong cylinder. We simulate this by stopping after one
    // sector, matching the single-sector-per-command behaviour real hardware gives.
    const physCyl = this.pcn[this.physUnit(unit)];
    this.exSingleSector = (sector.c !== physCyl);

    this.phase = Phase.Execution;
  }

  /**
   * Read Track — return entire raw track data including gaps and IDs.
   * Critical for Speedlock protection which checks gap sizes and timing.
   */
  private cmdReadTrack(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;
    const c = this.cmdBuf[2], h = this.cmdBuf[3];
    const r = this.cmdBuf[4], n = this.cmdBuf[5];
    const eot = this.cmdBuf[6];

    this.log(`  → Unit=${unit} Head=${head} C=${c} H=${h} R=${r} N=${n} EOT=${eot} — Read Track`);

    const track = this.getTrack(unit, head);

    if (!track || track.sectors.length === 0) {
      // No disk or empty track — NR before execution, ST1/ST2=0
      this.log(`  ✗ No disk or empty track`);
      const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
      this.result([st0, 0x00, 0x00, c, h, r, n]);
      return;
    }

    // READ TRACK (Read Diagnostic) transfers the sectors' DATA FIELDS to the
    // host, in physical order starting from the index hole — NOT the
    // gap/sync/ID/CRC bytes. It reads up to EOT sectors (the sector counter,
    // capped to the track) and the result reports the last sector's actual
    // CHRN. Loaders that read offset-sector tracks this way (Alkatraz tracks
    // 7–31, sectors R177+) rely on getting real sector data and the true R in
    // the result; returning the raw track (gap filler first) feeds them 0x4E
    // where they expect data and they fail with a disk error.
    const count = Math.max(1, Math.min(eot, track.sectors.length));
    const sectors = track.sectors.slice(0, count);
    let totalLen = 0;
    for (const s of sectors) totalLen += 128 << s.n;
    const buf = new Uint8Array(totalLen);
    let dst = 0;
    for (const s of sectors) {
      const sz = 128 << s.n;
      buf.set(s.data.subarray(0, sz), dst); // short sectors leave a zero tail
      dst += sz;
    }
    const last = sectors[sectors.length - 1];
    this.log(`  ✓ Read Track: ${sectors.length} sector(s), ${totalLen} data bytes (R${sectors[0].r}..R${last.r})`);

    // Save execution state — result reports the last sector's real ID field
    this.exUnit = unit;
    this.exHead = head;
    this.exC = last.c;
    this.exH = last.h;
    this.exN = last.n;
    this.exR = last.r;
    this.exEOT = eot;
    this.exHitEOT = false;
    this.exAbnormal = false;
    this.exTrack = track;
    this.exWriting = false;
    this.exReadTrack = true; // Flag: reading a whole track, don't advance per-sector
    this.exST1 = 0;
    this.exST2 = 0;

    // Latch for UI display
    this.latchR = last.r;
    this.latchHead = head;
    this.latchWriting = false;
    this.latchFrames = 25;

    this.exBuf = buf;
    this.exPos = 0;
    this.phase = Phase.Execution;
  }

  /** Read ID — return CHRN of current sector under the head. */
  private cmdReadID(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;

    const track = this.getTrack(unit, head);

    if (!track || track.sectors.length === 0) {
      // No disk or empty track — NR before execution, ST1/ST2=0
      this.log(`  ✗ No disk or empty track for Read ID`);
      const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
      this.result([st0, 0x00, 0x00, 0, 0, 0, 0]);
      return;
    }

    // Cycle through sectors on repeated calls (ROM uses this to discover layout)
    const physU = this.physUnit(unit);
    const idx = this.idIndex[physU] % track.sectors.length;
    this.idIndex[physU] = idx + 1;
    const sector = track.sectors[idx];

    this.log(`  → Unit=${unit} Head=${head} returning sector ID: C=${sector.c} H=${sector.h} R=${sector.r} N=${sector.n}`);
    const st0 = (head << 2) | unit; // normal termination
    this.result([st0, 0x00, 0x00, sector.c, sector.h, sector.r, sector.n]);
  }

  /**
   * Format Track.
   * cmdBuf: [cmd, HDS, N, SC, GPL, D]
   *   N   = sector size code (128 << N bytes per sector)
   *   SC  = sectors per cylinder
   *   GPL = gap 3 length
   *   D   = filler byte
   *
   * Execution phase: CPU writes SC×4 bytes (C, H, R, N per sector).
   * On completion the track in the disk image is rebuilt from those IDs,
   * each sector filled with D, then normal termination is returned.
   */
  private cmdFormat(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;
    const n   = this.cmdBuf[2];
    const sc  = this.cmdBuf[3];
    const gpl = this.cmdBuf[4];
    const d   = this.cmdBuf[5];

    const physU = this.physUnit(unit);
    if (!this.disks[physU]) {
      this.log(`  ✗ No disk in unit ${unit}`);
      const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
      this.result([st0, 0x00, 0x00, 0, head, 0, n]);
      return;
    }
    if (this.writeProtect[physU]) {
      this.log(`  ✗ Drive ${unit} write-protected`);
      const st0 = ST0_ABNORMAL | (head << 2) | unit;
      this.result([st0, 0x02, 0x00, 0, head, 0, n]); // ST1 bit 1 = NW
      return;
    }

    this.log(`  → Unit=${unit} Head=${head} N=${n} SC=${sc} GPL=${gpl} Fill=0x${d.toString(16).padStart(2, '0')}`);

    this.exUnit      = unit;
    this.exHead      = head;
    this.exN         = n;
    this.exSC        = sc;
    this.exGPL       = gpl;
    this.exFiller    = d;
    this.exFormatting = true;
    this.exWriting   = true;
    this.exHitEOT    = false;
    this.exST1       = 0;
    this.exST2       = 0;
    // Receive SC×4 bytes from CPU: one (C, H, R, N) tuple per sector
    this.exBuf = new Uint8Array(sc * 4);
    this.exPos = 0;

    this.latchWriting = true;
    this.latchFrames  = 25;

    this.phase = Phase.Execution;
  }

  /** Rebuild the current track from received sector IDs, then finish. */
  private finishFormat(): void {
    const physU = this.physUnit(this.exUnit);
    const disk = this.disks[physU];
    if (!disk) { this.finishExecution(); return; }

    const cyl    = this.pcn[physU];
    const head   = this.exHead;
    const sc     = this.exSC;
    const filler = this.exFiller;
    const gpl    = this.exGPL;
    const buf    = this.exBuf;

    // Build sector list from the CPU-supplied (C, H, R, N) tuples
    const sectors: DskSector[] = [];
    const sectorMap = new Map<number, number>();
    let lastR = 0;
    for (let i = 0; i < sc; i++) {
      const c = buf[i * 4];
      const h = buf[i * 4 + 1];
      const r = buf[i * 4 + 2];
      const n = buf[i * 4 + 3];
      const data = new Uint8Array(128 << n).fill(filler);
      sectors.push({ c, h, r, n, st1: 0, st2: 0, data });
      sectorMap.set(r, i);
      lastR = r;
    }

    // Extend tracks array if this cylinder is beyond what the image has
    while (disk.tracks.length <= cyl) {
      disk.tracks.push(Array.from({ length: disk.numSides }, () => null));
    }
    // Honour the flippy side offset so a format while "Side B" is loaded writes
    // to the image's second side, matching what getTrack() reads back.
    const side = Math.min(head + this.flipSide[physU], disk.numSides - 1);
    disk.tracks[cyl][side] = { sectors, sectorMap, gap3: gpl, filler };
    this.dirty[physU] = true;

    this.log(`  ✓ Formatted cyl=${cyl} head=${head}: ${sc} sectors, last R=${lastR}`);

    // Signal to the UI layer that metadata needs refreshing
    this.formattedUnit = this.exUnit;

    // Set result fields for finishExecution() — which also clears exFormatting
    this.exC   = cyl;
    this.exH   = head;
    this.exR   = lastR;
    this.exST1 = 0;
    this.exST2 = 0;

    this.finishExecution();
  }

  /** Version — 0x80 = enhanced controller (uPD765A compatible). */
  private cmdVersion(): void {
    this.result([0x80]);
  }

  /**
   * SCAN_EQUAL/LOW_EQ/HIGH_EQ — deliberately unimplemented.
   *
   * SCAN is a host-writes-comparison-bytes operation (the CPU streams bytes for
   * the FDC to compare against disk data, setting ST2.SH/SN on the outcome). No
   * known +3 software issues it — the command was buggy on early NEC 765 / Intel
   * 8272 parts and the industry routed around it, so +3DOS and CP/M Plus never
   * adopted it. Rather than silently mis-execute it as a plain read (wrong data
   * direction, scan-result bits never set), we reject it as an invalid command
   * and raise a visible UI notice. If real software ever trips this, we'll know
   * — and can implement it properly then.
   */
  private cmdUnsupportedScan(): void {
    const cmd = this.cmdBuf[0] & 0x1F;
    const unit = this.cmdBuf[1] & 0x03;
    this.log(`  ✗ UNSUPPORTED SCAN ${this.getCommandName(cmd)} (0x${cmd.toString(16).padStart(2, '0').toUpperCase()})`,
             `unit=${unit} C=${this.cmdBuf[2]} H=${this.cmdBuf[3]} R=${this.cmdBuf[4]} N=${this.cmdBuf[5]} — rejected as invalid command`);
    this.unsupportedScan = cmd; // UI picks this up next frame
    this.result([ST0_INVALID]);
  }

  /** Invalid/unrecognised command — return ST0 with invalid-command code. */
  private cmdInvalid(): void {
    this.log(`  ✗✗✗ INVALID/UNIMPLEMENTED COMMAND! Command byte: 0x${this.cmdBuf[0].toString(16).padStart(2, '0').toUpperCase()}`);
    this.log(`      Full command buffer: [${this.cmdBuf.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
    this.result([ST0_INVALID]);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private result(bytes: number[]): void {
    this.resBuf = bytes;
    this.resPos = 0;
    this.phase = bytes.length > 0 ? Phase.Result : Phase.Idle;
  }

  reset(): void {
    this.phase = Phase.Idle;
    this.cmdBuf = [];
    this.cmdExpected = 0;
    this.resBuf = [];
    this.resPos = 0;
    this.intPending = false;
    this.intST0 = 0;
    this.intPCN = 0;
    this.pcn = [0, 0, 0, 0];
    this.motorOn = false;
    this.exBuf = new Uint8Array(0);
    this.exPos = 0;
    this.exWriting = false;
    this.exReadTrack = false;
    this.exFormatting = false;
    this.exTrack = null;
    this.exST1 = 0;
    this.exST2 = 0;
    this.latchR = 0;
    this.latchHead = 0;
    this.latchWriting = false;
    this.latchFrames = 0;
    // Note: disk image and idIndex intentionally preserved across reset
  }
}
