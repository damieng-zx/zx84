/**
 * WD179x Floppy Disk Controller — shared base for the Western Digital FD179x
 * family. The MGT +D uses a WD1772 (see wd1772.ts); the Beta Disk interface
 * uses a WD1793 (see wd1793.ts). Both are register-compatible: four
 * directly-addressed registers and a synchronous command model with no
 * command/result phases.
 *
 *   Status / Command   (read / write)
 *   Track              (read / write)
 *   Sector             (read / write)
 *   Data               (read / write)
 *
 * The drive and side are selected by the owning peripheral's control register,
 * which calls selectDrive() / setSide().
 *
 * Data transfer is modelled instantly: after a READ/WRITE SECTOR command the
 * status shows BUSY|DRQ and the CPU streams the sector's bytes through the data
 * register — exactly the polling loop G+DOS / TR-DOS use (poll status,
 * read/write data, repeat while BUSY). Disk images are the shared DskImage
 * structure (see floppy/disk-image.ts) so geometry, sector lookup and write-back match
 * the +3 path and the existing disk UI / floppy-sound code can be reused.
 *
 * Status register bit meanings differ between Type I (Restore/Seek/Step) and
 * Type II/III (Read/Write). We set the bits explicitly per command so the
 * caller's interpretation matches; the comments below give both meanings.
 *
 * The three chip-specific differences are isolated behind protected hooks so
 * the concrete WD1772 / WD1793 subclasses only override what actually differs:
 *   • statusBit7()          — WD1772: MOTOR ON; WD1793: NOT READY.
 *   • formatSectorsPerTrack — sectors per track a WRITE TRACK lays down.
 *   • (intrq/drq getters)   — exposed for the Beta system port; +D ignores them.
 */

import type { DskImage, DskTrack, DskSector } from '@/media/floppy/disk-image.ts';

// ── Status register bits ────────────────────────────────────────────────────
// Bit meanings differ by command type; alternate Type-I meanings are noted in
// comments. (0x02 = DRQ for Type II/III, INDEX for Type I; 0x04 = LOST DATA for
// Type II/III, TRACK0 for Type I; 0x10 = RNF for Type II/III, SEEK ERR for Type I.)
const ST_BUSY      = 0x01; // all commands: command in progress
const ST_DRQ       = 0x02; // Type II/III: data register needs service
const ST_INDEX     = 0x02; // Type I: index pulse (same bit as DRQ)
const ST_TRACK0    = 0x04; // Type I: head over track 0
const ST_RNF       = 0x10; // Type II/III: record not found
const ST_RECTYPE   = 0x20; // Type II read: record type / Type I: head loaded
const ST_WRITEPROT = 0x40; // write protected
/** Status bit 7 — WD1772: MOTOR ON (no READY line on the 1770/1772);
 *  WD1793: NOT READY. Which meaning applies is decided by statusBit7(). */
const ST_BIT7      = 0x80;

/** Frames the activity LED / sector readout lingers after a transfer. */
const LATCH_FRAMES = 25;
/** Frames the motor keeps spinning after the last command. */
const MOTOR_FRAMES = 50;

// INDEX pulse emulation. G+DOS / TR-DOS confirm a disk is spinning by watching
// status bit 1 (INDEX, in Type I status) transition 0→1. We synthesise that
// pulse from a per-status-read counter so the edge always appears: bit 1 reads
// 1 for the first INDEX_WIDTH of every INDEX_PERIOD status reads, else 0.
const INDEX_PERIOD = 16;
const INDEX_WIDTH = 4;

/** Status reads a Type I command holds BUSY set before revealing its result,
 *  when {@link WD179x.pulseBusy} is enabled. Real WD177x hardware always holds
 *  BUSY while a command executes; some ROMs (the Einstein MOS) poll for BUSY to
 *  *set* as a command-accepted handshake before waiting for it to clear. Small
 *  vs any driver's completion timeout. */
const BUSY_PULSE_READS = 4;

export class WD179x {
  // ── Registers ─────────────────────────────────────────────────────────
  private statusReg = 0;
  trackReg = 0;
  sectorReg = 0;
  private dataReg = 0;

  // ── Drive / head state ────────────────────────────────────────────────
  /** Selected drive (0 or 1) — set by the peripheral's control register. */
  currentDrive = 0;
  /** Selected side (0 or 1) — set by the peripheral's control register. */
  side = 0;
  motorOn = false;
  private stepDir = 1; // +1 toward higher-numbered tracks
  /** Physical head position per drive (independent of the single track reg). */
  private headTrack = [0, 0];
  /** True when the last command was Type I or Force Interrupt — i.e. status
   *  bit 1 means INDEX (not DRQ). Gates the synthesised index pulse. */
  private typeICmd = true;
  /** Advances on each status read to phase the synthesised index pulse. */
  private indexCounter = 0;

  /** When true, Type I commands assert BUSY for a few status reads before
   *  revealing their result (realistic WD177x behaviour). Off by default so the
   *  +D / Beta Disk keep their instant-completion model; the Einstein enables it
   *  because its MOS polls for BUSY to *set* as a command-accepted handshake. */
  pulseBusy = false;
  private busyCountdown = 0;
  private busyDoneStatus = 0;

  // ── Disk images ───────────────────────────────────────────────────────
  protected disks: (DskImage | null)[] = [null, null];
  /** Per-drive write-protect (software tab). */
  writeProtect = [false, false];
  /** Per-drive force-ready override and flippy-disk side selection. Present for
   *  parity with the uPD765A so both FDCs satisfy the shared `Machine.fdc`
   *  surface; inert on the WD179x (its drives are always ready when a disk is
   *  present and images are not treated as flippy). */
  forceReady = [false, false];
  flipSide = [0, 0];
  /** Optional command-log sink (parity with the uPD765A's `logFn` so the MCP
   *  fdc-log tool can attach through the shared `Machine.fdc`). Unused by the
   *  WD179x today; wired when Einstein/+D/Beta FDC logging is added. */
  logFn: ((...args: unknown[]) => void) | null = null;

  // ── Chip-specific hooks (overridden by subclasses) ────────────────────
  /** Status bit 7. Default (WD1772) is the MOTOR ON line. The WD1793 overrides
   *  this to report NOT READY (set when the selected drive has no disk). */
  protected statusBit7(): number {
    return this.motorOn ? ST_BIT7 : 0;
  }
  /** Sectors a WRITE TRACK (format) lays down before the track is finalised.
   *  G+DOS writes 10 × 512-byte sectors; TR-DOS writes 16 × 256. */
  protected readonly formatSectorsPerTrack: number = 10;

  /**
   * Set to a unit (0/1) when a WRITE TRACK (format) completes; cleared by the
   * UI layer after it refreshes disk metadata. -1 = nothing pending.
   */
  formattedUnit = -1;

  // ── Data-transfer buffer ──────────────────────────────────────────────
  private buffer: Uint8Array | null = null;
  private bufPos = 0;
  private writing = false;
  private multi = false;        // multi-sector (read 0x9x / write 0xBx)
  private curTrack: DskTrack | null = null;

  // ── Write-track (format) parser state ─────────────────────────────────
  private formatting = false;
  private fmtState: 'idle' | 'id' | 'data' = 'idle';
  private fmtId: number[] = [];
  private fmtSectors: DskSector[] = [];
  private fmtDataLeft = 0;
  private fmtPending: DskSector | null = null;
  private fmtBytesLeft = 0;     // scratch budget so the command always ends

  // ── UI latches ────────────────────────────────────────────────────────
  private latchFrames = 0;
  private latchWriting = false;
  private latchSector = 0;
  private motorFrames = 0;

  reset(): void {
    this.statusReg = 0;
    this.trackReg = 0;
    this.sectorReg = 0;
    this.dataReg = 0;
    this.currentDrive = 0;
    this.side = 0;
    this.motorOn = false;
    this.stepDir = 1;
    this.headTrack = [0, 0];
    this.typeICmd = true;
    this.indexCounter = 0;
    this.buffer = null;
    this.bufPos = 0;
    this.writing = false;
    this.multi = false;
    this.curTrack = null;
    this.formatting = false;
    this.fmtState = 'idle';
    this.latchFrames = 0;
    this.motorFrames = 0;
    this.busyCountdown = 0;
  }

  /**
   * Per-drive "written since insert" flag (drives C/D). Set when a sector
   * write or format mutates the image, cleared on insert/eject and on save.
   * Drives the Save button's "unsaved changes" indicator in the UI.
   */
  dirty = [false, false];

  // ── Disk management ───────────────────────────────────────────────────
  insertDisk(image: DskImage, unit = 0): void { this.disks[unit & 1] = image; this.dirty[unit & 1] = false; }
  ejectDisk(unit = 0): void { this.disks[unit & 1] = null; this.dirty[unit & 1] = false; }
  getDiskImage(unit: number): DskImage | null { return this.disks[unit & 1]; }

  /** True if the disk in `unit` has unsaved writes since insert/save. */
  isDirty(unit: number): boolean { return this.dirty[unit & 1]; }

  /** Clear the dirty flag — called once the modified image has been saved. */
  clearDirty(unit: number): void { this.dirty[unit & 1] = false; }

  selectDrive(unit: number): void { this.currentDrive = unit & 1; }
  setSide(side: number): void { this.side = side & 1; }

  // ── State getters (for the UI / floppy sound) ─────────────────────────
  get currentUnit(): number { return this.currentDrive; }
  get currentTrack(): number { return this.headTrack[this.currentDrive]; }
  getUnitTrack(unit: number): number { return this.headTrack[unit & 1]; }
  get currentSector(): number {
    if (this.buffer) return this.sectorReg;
    return this.latchFrames > 0 ? this.latchSector : 0;
  }
  get isExecuting(): boolean { return this.buffer !== null || this.latchFrames > 0; }
  get isWriting(): boolean {
    if (this.buffer) return this.writing;
    return this.latchFrames > 0 ? this.latchWriting : false;
  }

  // ── Interrupt / data-request lines (read by the Beta system port) ─────
  /** INTRQ — asserted when a command has completed (BUSY clear). Our transfers
   *  finish synchronously, so "not BUSY" is the completion signal TR-DOS polls. */
  get intrq(): boolean { return (this.statusReg & ST_BUSY) === 0; }
  /** DRQ — the data register needs servicing during a Type II/III transfer. */
  get drq(): boolean { return !this.typeICmd && (this.statusReg & ST_DRQ) !== 0; }

  /** Decay the display latches and spin the motor down when idle. */
  tickFrame(): void {
    if (this.latchFrames > 0) this.latchFrames--;
    if (this.motorFrames > 0 && --this.motorFrames === 0) this.motorOn = false;
  }

  // ── Register reads (status/track/sector/data ports) ───────────────────

  /** Status register. In Type I status, synthesise the INDEX pulse (bit 1)
   *  when a disk is present and spinning so the ROM's index-edge detector sees
   *  the 0→1 transition it needs. */
  readStatus(): number {
    // Type I BUSY pulse: hold BUSY set for the first few reads after the command,
    // then reveal the completed status (see endTypeI / pulseBusy).
    if (this.busyCountdown > 0) {
      if (--this.busyCountdown === 0) this.statusReg = this.busyDoneStatus;
      return this.statusReg;
    }
    if (this.typeICmd && (this.statusReg & ST_BUSY) === 0
        && this.motorOn && this.disks[this.currentDrive] !== null) {
      this.indexCounter = (this.indexCounter + 1) % INDEX_PERIOD;
      if (this.indexCounter < INDEX_WIDTH) this.statusReg |= ST_INDEX;
      else this.statusReg &= ~ST_INDEX;
    }
    return this.statusReg;
  }
  readTrack(): number { return this.trackReg; }
  readSectorReg(): number { return this.sectorReg; }

  /** Data register — streams sector bytes during a read. */
  readData(): number {
    if (this.buffer !== null && !this.writing) {
      const v = this.buffer[this.bufPos++];
      this.dataReg = v;
      if (this.bufPos >= this.buffer.length) this.finishRead();
      return v;
    }
    return this.dataReg;
  }

  // ── Register writes ───────────────────────────────────────────────────
  writeTrack(v: number): void { this.trackReg = v & 0xFF; }
  writeSectorReg(v: number): void { this.sectorReg = v & 0xFF; }

  /** Data register — sector bytes during write, else the SEEK target track or a
   *  register load. */
  writeData(v: number): void {
    v &= 0xFF;
    this.dataReg = v;
    if (this.formatting) { this.formatByte(v); return; }
    if (this.buffer !== null && this.writing) {
      this.buffer[this.bufPos++] = v;
      if (this.bufPos >= this.buffer.length) this.finishWrite();
    }
  }

  // ── Command register ──────────────────────────────────────────────────
  writeCommand(cmd: number): void {
    cmd &= 0xFF;
    this.motorOn = true;
    this.motorFrames = MOTOR_FRAMES;
    this.busyCountdown = 0; // drop any pending Type I BUSY pulse from a prior cmd
    const hi = cmd >> 4;
    // Type I (0x0-0x7) and Force Interrupt (0xD) leave the controller in Type I
    // status, where bit 1 = INDEX. Everything else is Type II/III (bit 1 = DRQ).
    this.typeICmd = hi <= 0x7 || hi === 0xD;
    switch (hi) {
      case 0x0: this.restore(); break;
      case 0x1: this.seek(); break;
      case 0x2: case 0x3: this.step(cmd, 0); break;
      case 0x4: case 0x5: this.step(cmd, +1); break;
      case 0x6: case 0x7: this.step(cmd, -1); break;
      case 0x8: case 0x9: this.readSectorCmd(hi === 0x9); break;
      case 0xA: case 0xB: this.writeSectorCmd(hi === 0xB); break;
      case 0xC: this.readAddress(); break;
      case 0xD: this.forceInterrupt(); break;
      case 0xE: this.readTrackCmd(); break;
      case 0xF: this.writeTrackCmd(); break;
    }
  }

  // ── Type I: Restore / Seek / Step ─────────────────────────────────────
  private restore(): void {
    this.headTrack[this.currentDrive] = 0;
    this.trackReg = 0;
    this.endTypeI();
  }

  private seek(): void {
    const target = Math.max(0, Math.min(79, this.dataReg));
    this.headTrack[this.currentDrive] = target;
    this.trackReg = target;
    this.endTypeI();
  }

  private step(cmd: number, dir: number): void {
    if (dir !== 0) this.stepDir = dir;
    const next = Math.max(0, Math.min(79, this.headTrack[this.currentDrive] + this.stepDir));
    this.headTrack[this.currentDrive] = next;
    if (cmd & 0x10) this.trackReg = next; // 'T' update-track-register flag
    this.endTypeI();
  }

  private endTypeI(): void {
    let s = ST_RECTYPE; // head loaded / spin-up complete
    s |= this.statusBit7();
    if (this.headTrack[this.currentDrive] === 0) s |= ST_TRACK0;
    if (this.writeProtect[this.currentDrive]) s |= ST_WRITEPROT;
    if (this.pulseBusy) {
      // Hold BUSY for a few reads (see BUSY_PULSE_READS) so a "wait for BUSY set"
      // handshake sees it; readStatus reveals `s` once the pulse expires.
      this.busyDoneStatus = s;
      this.busyCountdown = BUSY_PULSE_READS;
      this.statusReg = s | ST_BUSY;
    } else {
      this.statusReg = s; // BUSY cleared — completes instantly (legacy model)
    }
  }

  // ── Type II: Read / Write sector ──────────────────────────────────────
  private locateTrack(): DskTrack | null {
    const disk = this.disks[this.currentDrive];
    if (!disk) return null;
    return disk.tracks[this.headTrack[this.currentDrive]]?.[this.side] ?? null;
  }

  private base(): number { return this.statusBit7(); }

  private readSectorCmd(multi: boolean): void {
    const track = this.locateTrack();
    if (!track) { this.statusReg = this.base() | ST_RNF; return; }
    const idx = track.sectorMap.get(this.sectorReg);
    if (idx === undefined) { this.statusReg = this.base() | ST_RNF; return; }
    const sec = track.sectors[idx];
    this.buffer = sec.data;
    this.bufPos = 0;
    this.writing = false;
    this.multi = multi;
    this.curTrack = track;
    this.statusReg = this.base() | ST_BUSY | ST_DRQ;
    this.latch(false);
  }

  private writeSectorCmd(multi: boolean): void {
    if (this.writeProtect[this.currentDrive]) {
      this.statusReg = this.base() | ST_WRITEPROT;
      return;
    }
    const track = this.locateTrack();
    if (!track) { this.statusReg = this.base() | ST_RNF; return; }
    const idx = track.sectorMap.get(this.sectorReg);
    if (idx === undefined) { this.statusReg = this.base() | ST_RNF; return; }
    const sec = track.sectors[idx];
    this.buffer = sec.data;      // written into the image in place
    this.bufPos = 0;
    this.writing = true;
    this.multi = multi;
    this.curTrack = track;
    this.dirty[this.currentDrive] = true;
    this.statusReg = this.base() | ST_BUSY | ST_DRQ;
    this.latch(true);
  }

  private finishRead(): void {
    if (this.multi && this.advanceSector(false)) return;
    this.buffer = null;
    this.statusReg = this.base();
  }

  private finishWrite(): void {
    if (this.multi && this.advanceSector(true)) return;
    this.buffer = null;
    this.statusReg = this.base();
  }

  /** Multi-sector continuation: bump R and load the next sector if present. */
  private advanceSector(writing: boolean): boolean {
    this.sectorReg = (this.sectorReg + 1) & 0xFF;
    const idx = this.curTrack?.sectorMap.get(this.sectorReg);
    if (this.curTrack && idx !== undefined) {
      this.buffer = this.curTrack.sectors[idx].data;
      this.bufPos = 0;
      this.writing = writing;
      this.statusReg = this.base() | ST_BUSY | ST_DRQ;
      this.latch(writing);
      return true;
    }
    return false;
  }

  // ── Type III: Read address / Read track / Write track ─────────────────
  private readAddress(): void {
    const track = this.locateTrack();
    if (!track || track.sectors.length === 0) {
      this.statusReg = this.base() | ST_RNF;
      return;
    }
    const sec = track.sectors[0];
    // 6-byte ID: track, side, sector, size code, CRC hi, CRC lo (CRC faked 0).
    this.buffer = Uint8Array.from([sec.c, sec.h, sec.r, sec.n, 0, 0]);
    this.bufPos = 0;
    this.writing = false;
    this.multi = false;
    this.sectorReg = sec.c; // datasheet: track value lands in the sector reg
    this.statusReg = this.base() | ST_BUSY | ST_DRQ;
  }

  private readTrackCmd(): void {
    // Rarely used; serve the concatenated sector data of the track.
    const track = this.locateTrack();
    if (!track) { this.statusReg = this.base() | ST_RNF; return; }
    const total = track.sectors.reduce((n, s) => n + s.data.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const s of track.sectors) { buf.set(s.data, off); off += s.data.length; }
    this.buffer = buf;
    this.bufPos = 0;
    this.writing = false;
    this.multi = false;
    this.statusReg = this.base() | ST_BUSY | ST_DRQ;
  }

  private writeTrackCmd(): void {
    if (this.writeProtect[this.currentDrive]) {
      this.statusReg = this.base() | ST_WRITEPROT;
      return;
    }
    // Begin parsing the MFM byte stream the CPU writes (ID marks 0xFE, data
    // marks 0xFB/0xF8, CRC request 0xF7). We rebuild standard sectors from it.
    this.formatting = true;
    this.fmtState = 'idle';
    this.fmtId = [];
    this.fmtSectors = [];
    this.fmtPending = null;
    this.fmtBytesLeft = 8192; // budget so a malformed stream still terminates
    this.statusReg = this.base() | ST_BUSY | ST_DRQ;
  }

  private formatByte(b: number): void {
    if (--this.fmtBytesLeft <= 0) { this.finishFormat(); return; }
    switch (this.fmtState) {
      case 'idle':
        if (b === 0xFE) { this.fmtState = 'id'; this.fmtId = []; }
        else if (b === 0xFB || b === 0xF8) {
          if (this.fmtPending) {
            this.fmtDataLeft = this.fmtPending.data.length;
            this.fmtState = 'data';
          }
        }
        break;
      case 'id':
        this.fmtId.push(b);
        if (this.fmtId.length >= 4) {
          const [c, h, r, n] = this.fmtId;
          this.fmtPending = { c, h, r, n, st1: 0, st2: 0, data: new Uint8Array(128 << (n & 7)) };
          this.fmtState = 'idle';
        }
        break;
      case 'data':
        if (this.fmtPending) {
          const sec = this.fmtPending;
          sec.data[sec.data.length - this.fmtDataLeft] = b;
        }
        if (--this.fmtDataLeft <= 0) {
          if (this.fmtPending) this.fmtSectors.push(this.fmtPending);
          this.fmtPending = null;
          this.fmtState = 'idle';
          // Finalise once a full track's worth of sectors has arrived.
          if (this.fmtSectors.length >= this.formatSectorsPerTrack) this.finishFormat();
        }
        break;
    }
  }

  private finishFormat(): void {
    this.formatting = false;
    const disk = this.disks[this.currentDrive];
    const cyl = this.headTrack[this.currentDrive];
    if (disk && this.fmtSectors.length > 0) {
      const sectorMap = new Map<number, number>();
      this.fmtSectors.forEach((s, i) => sectorMap.set(s.r, i));
      const track: DskTrack = { sectors: this.fmtSectors, sectorMap, gap3: 82, filler: 0xE5 };
      // Grow the cylinder array if the disk image is shorter than this track.
      while (disk.tracks.length <= cyl) disk.tracks.push([]);
      const sides = disk.tracks[cyl];
      sides[this.side] = track;
      disk.numTracks = Math.max(disk.numTracks, cyl + 1);
      disk.numSides = Math.max(disk.numSides, this.side + 1);
      this.dirty[this.currentDrive] = true;
      this.formattedUnit = this.currentDrive;
    }
    this.buffer = null;
    this.statusReg = this.base();
  }

  // ── Type IV: Force interrupt ──────────────────────────────────────────
  private forceInterrupt(): void {
    this.buffer = null;
    this.formatting = false;
    let s = this.base();
    if (this.headTrack[this.currentDrive] === 0) s |= ST_TRACK0;
    if (this.writeProtect[this.currentDrive]) s |= ST_WRITEPROT;
    this.statusReg = s; // BUSY cleared
  }

  private latch(writing: boolean): void {
    this.latchFrames = LATCH_FRAMES;
    this.latchWriting = writing;
    this.latchSector = this.sectorReg;
  }
}
