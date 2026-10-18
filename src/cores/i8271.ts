/**
 * Intel 8271 floppy disk controller — the FDC the BBC Micro Model B shipped
 * with, driven by Acorn DFS 1.20. Unlike the WD179x (wd179x.ts) it is a
 * command / parameter / result machine: the host writes a command byte, then
 * its parameter bytes one at a time, the chip runs the command, and a result
 * byte is read back.
 *
 *   offset 0  read: status           write: command
 *   offset 1  read: result           write: parameter
 *   offset 2  write: reset (bit 0 high)
 *   offset 3  unmapped (reads 0xFF)
 *   data port read/write: one byte of a sector transfer (FE84 on the BBC)
 *
 * Sector data moves through the data port under DATA REQUEST. In the BBC's
 * non-DMA mode the chip raises its interrupt line for each byte as well as on
 * completion, and the machine wires that line to the CPU NMI.
 *
 * This is a functional model, not a bitstream one: there is no flux layer and
 * sectors come straight from the shared `DskImage` structure that the uPD765A
 * and WD179x cores also use, so SSD/DSD/DSK geometry and write-back are shared.
 * Command timing (the busy delay before a result, the pacing of data bytes) and
 * the sector-not-found code are the values Acorn DFS has been observed to work
 * with in other emulators; nothing is copied from them.
 *
 * Structure: the command set is a table keyed by opcode, each entry giving the
 * parameter count and an action. Time is a single one-shot alarm that the
 * machine advances with `tick`; each command schedules its own continuations.
 */

import type { DskImage, DskSector } from '@/media/floppy/disk-image.ts';

export interface I8271Options {
  /** Interrupt output — the BBC wires this to the CPU NMI line. */
  onInterrupt?: (asserted: boolean) => void;
}

/** Status register bits, exported for tests and the BBC peripheral. */
export const I8271Status = {
  BSY: 0x80,  // a command is running
  CF: 0x40,   // command register holds a byte awaiting its parameters
  PF: 0x20,   // parameter register full (never set: parameters are consumed at once)
  RF: 0x10,   // a result byte is waiting
  IRQ: 0x08,  // interrupt line is asserted
  DRQ: 0x04,  // data port needs service (non-DMA mode only)
} as const;

/** Result codes, exported for tests and the BBC peripheral. */
export const I8271Result = {
  NONE: 0x00,  // completed without error
  ICRC: 0x0c,  // ID field CRC error
  DCRC: 0x0e,  // data field CRC error
  NR: 0x10,    // drive not ready
  WP: 0x12,    // write protected
  T0NF: 0x14,  // track 0 not found
  NF: 0x1e,    // sector not found
} as const;

// ── Special registers (WRITE / READ SPECIAL REGISTER, SPECIFY) ──────────────
// All of the chip's addressable registers live in one 64-entry file indexed by
// the address the host quotes. The two head-position registers double as the
// "current track" of each drive.
const REG_BAD_TRACK_0 = 0x10;  // two bytes: drive 0 bad tracks 1 and 2
const REG_HEAD_0 = 0x12;       // drive 0 current track
const REG_MODE = 0x17;
const REG_BAD_TRACK_1 = 0x18;  // two bytes: drive 1 bad tracks 1 and 2
const REG_HEAD_1 = 0x1a;       // drive 1 current track
const REG_DRIVE_OUT = 0x23;    // drive select / side / head load outputs
const REG_FILE_SIZE = 0x40;

const HEAD_REG = [REG_HEAD_0, REG_HEAD_1] as const;
/** Registers the host may touch; anything else reads 0 and ignores writes. */
const VALID_REGS = new Set([
  REG_BAD_TRACK_0, REG_BAD_TRACK_0 + 1, REG_HEAD_0, REG_MODE,
  REG_BAD_TRACK_1, REG_BAD_TRACK_1 + 1, REG_HEAD_1, REG_DRIVE_OUT,
]);

const MODE_NON_DMA = 0x01;     // 1 = host moves data through the port (BBC)
const MODE_FORCED = 0xc0;      // always reads back set
const OUT_SIDE = 0x20;
const OUT_HEAD_LOAD = 0x08;
const OUT_SELECT_BITS = 0xc0;  // drive-select field, supplied by the command byte on read-back
const SELECT_0 = 0x40;
const SELECT_1 = 0x80;

const SPECIFY_TIMING = 0x0d;

// ── READ DRIVE STATUS result bits ───────────────────────────────────────────
const DRIVE_BIT7 = 0x80;     // always set
const DRIVE_1_READY = 0x40;
const DRIVE_WRITE_PROT = 0x08;
const DRIVE_0_READY = 0x04;
const DRIVE_TRACK_0 = 0x02;

// ── Pacing (1 MHz disc clock) ───────────────────────────────────────────────
/** Delay between a command finishing and its result/interrupt appearing. */
const SETTLE_CYCLES = 50;
/** Spacing between data-port bytes of a transfer. */
const BYTE_CYCLES = 80;

/** Byte an erased sector is filled with by FORMAT. */
const ERASED = 0xe5;

type Stage = 'idle' | 'params' | 'busy' | 'transfer' | 'result';

interface Transfer {
  bytes: Uint8Array;
  at: number;
  /** True when the host supplies the bytes (a write); false for reads. */
  fromHost: boolean;
  /** Sectors a write is committed to when the last byte arrives. */
  targets: DskSector[];
  unit: number;
}

interface Command {
  /** Parameter bytes that follow the command byte. */
  args: number;
  run(chip: I8271): void;
}

export class I8271 {
  private readonly onInterrupt: (asserted: boolean) => void;

  // Command / result handshake
  private stage: Stage = 'idle';
  private readonly cmd = new Uint8Array(6);   // cmd[0] = opcode byte, then parameters
  private cmdLen = 0;
  private argsLeft = 0;
  private result = 0;
  private latch = 0;                          // last value on the data port

  // Lines
  private resultIrq = false;
  private dataReq = false;
  private lineHigh = false;

  // Register file and drive outputs
  private readonly regs = new Uint8Array(REG_FILE_SIZE);
  private readonly timing = new Uint8Array(4); // SPECIFY step/settle/load values; unused by this instant-seek model

  // Time and the transfer in flight
  private alarm: { left: number; fire: () => void } | null = null;
  private xfer: Transfer | null = null;

  // Media
  private readonly disks: (DskImage | null)[] = [null, null];
  private readonly written = [false, false];

  /** Per-unit write-protect tab. Public so the disk UI can toggle it. */
  readonly writeProtect: boolean[] = [false, false];

  /** Per-unit "a drive is wired to this select line". A single-drive machine
   *  clears unit 1, and READ DRIVE STATUS then reports it neither ready nor at
   *  track 0 — which is how the DFS decides it has one drive, not two. */
  readonly connected: boolean[] = [true, true];

  /** Last drive addressed — for the activity LED. */
  currentDrive = 0;
  /** Set when a command starts and cleared when its result is read. */
  motorOn = false;

  constructor(options: I8271Options = {}) {
    this.onInterrupt = options.onInterrupt ?? (() => {});
    this.reset();
  }

  // ── Indicators for the host's frame probe ─────────────────────────────────

  /** Sector data is moving through the data port right now. */
  get isExecuting(): boolean { return this.stage === 'transfer'; }
  /** That transfer is a write. */
  get isWriting(): boolean { return this.stage === 'transfer' && this.xfer?.fromHost === true; }
  /** Sector number of the command in flight (0 when idle). */
  get currentSector(): number { return this.stage === 'idle' ? 0 : this.cmd[2]; }
  /** Head position of a unit. */
  getUnitTrack(unit: number): number { return this.regs[HEAD_REG[unit & 1]]; }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Reset the chip. Inserted disks, write-protect tabs and wiring survive. */
  reset(): void {
    this.stage = 'idle';
    this.cmd.fill(0);
    this.cmdLen = 0;
    this.argsLeft = 0;
    this.result = 0;
    this.latch = 0;
    this.resultIrq = false;
    this.dataReq = false;
    this.regs.fill(0);
    this.regs[REG_MODE] = MODE_FORCED;
    this.timing.fill(0);
    this.alarm = null;
    this.xfer = null;
    this.currentDrive = 0;
    this.motorOn = false;
    this.refreshLine();
  }

  /** Advance time by `cycles` of the 1 MHz disc clock. */
  tick(cycles: number): void {
    const alarm = this.alarm;
    if (alarm === null) return;
    alarm.left -= cycles;
    if (alarm.left > 0) return;
    this.alarm = null;
    alarm.fire();
  }

  /** Per-frame hook, kept so the machine can pump every disc controller alike. */
  tickFrame(): void {}

  // ── Media ─────────────────────────────────────────────────────────────────

  insertDisk(image: DskImage, unit: number): void {
    const u = unit & 1;
    this.disks[u] = image;
    this.written[u] = false;
    this.regs[HEAD_REG[u]] = 0;
  }

  ejectDisk(unit: number): void {
    const u = unit & 1;
    this.disks[u] = null;
    this.written[u] = false;
  }

  getDiskImage(unit: number): DskImage | null { return this.disks[unit & 1]; }
  isDirty(unit: number): boolean { return this.written[unit & 1]; }
  clearDirty(unit: number): void { this.written[unit & 1] = false; }

  // ── Host register interface ───────────────────────────────────────────────

  read(offset: number): number {
    switch (offset & 3) {
      case 0: return this.statusByte();
      case 1: return this.takeResult();
      default: return 0xff;
    }
  }

  write(offset: number, value: number): void {
    const v = value & 0xff;
    switch (offset & 3) {
      case 0: this.acceptCommand(v); break;
      case 1: this.acceptParameter(v); break;
      case 2: if (v === 1) this.reset(); break;
      default: break;
    }
  }

  /** Data port read: the next byte of a read transfer. */
  readData(): number {
    const x = this.xfer;
    if (this.stage !== 'transfer' || x === null || x.fromHost || !this.dataReq) return this.latch;
    this.setDataReq(false);
    this.latch = x.bytes[x.at++];
    this.advanceTransfer(x);
    return this.latch;
  }

  /** Data port write: the next byte of a write transfer. */
  writeData(value: number): void {
    this.latch = value & 0xff;
    const x = this.xfer;
    if (this.stage !== 'transfer' || x === null || !x.fromHost || !this.dataReq) return;
    this.setDataReq(false);
    x.bytes[x.at++] = this.latch;
    this.advanceTransfer(x);
  }

  // ── Status and interrupt line ─────────────────────────────────────────────

  private get nonDma(): boolean { return (this.regs[REG_MODE] & MODE_NON_DMA) !== 0; }

  private statusByte(): number {
    let s = this.lineHigh ? I8271Status.IRQ : 0;
    switch (this.stage) {
      case 'params': s |= I8271Status.CF; break;
      case 'busy': s |= I8271Status.BSY; break;
      case 'transfer':
        s |= I8271Status.BSY;
        if (this.dataReq && this.nonDma) s |= I8271Status.DRQ;
        break;
      case 'result': s |= I8271Status.RF; break;
      default: break;
    }
    return s;
  }

  private setDataReq(on: boolean): void {
    this.dataReq = on;
    this.refreshLine();
  }

  private setResultIrq(on: boolean): void {
    this.resultIrq = on;
    this.refreshLine();
  }

  /** The interrupt line is the completion flag, or a pending data request while in non-DMA mode. */
  private refreshLine(): void {
    const high = this.resultIrq || (this.dataReq && this.nonDma);
    if (high === this.lineHigh) return;
    this.lineHigh = high;
    this.onInterrupt(high);
  }

  // ── Command intake ────────────────────────────────────────────────────────

  private acceptCommand(byte: number): void {
    if (this.stage !== 'idle') return;
    const spec = I8271.commands.get(byte & 0x3e);
    if (spec === undefined) return;
    this.cmd[0] = byte;
    this.cmdLen = 1;
    this.argsLeft = spec.args;
    if (spec.args === 0) spec.run(this);
    else this.stage = 'params';
  }

  private acceptParameter(byte: number): void {
    if (this.stage !== 'params') return;
    this.cmd[this.cmdLen++] = byte;
    if (--this.argsLeft > 0) return;
    I8271.commands.get(this.cmd[0] & 0x3e)!.run(this);
  }

  /** Opcode (low bit and drive-select bits ignored) → parameter count and action. */
  private static readonly commands = new Map<number, Command>([
    [0x0a, { args: 3, run: c => c.dataCommand('write') }],   // write data
    [0x0e, { args: 3, run: c => c.dataCommand('write') }],   // write deleted data
    [0x12, { args: 3, run: c => c.dataCommand('read') }],    // read data
    [0x16, { args: 3, run: c => c.dataCommand('read') }],    // read data and deleted data
    [0x1e, { args: 3, run: c => c.dataCommand('verify') }],  // verify data and deleted data
    [0x1a, { args: 3, run: c => c.readIds() }],
    [0x22, { args: 5, run: c => c.formatTrack() }],
    [0x28, { args: 1, run: c => c.seek() }],
    [0x2c, { args: 0, run: c => c.readDriveStatus() }],
    [0x34, { args: 4, run: c => c.specify() }],
    [0x3a, { args: 2, run: c => c.writeSpecial() }],
    [0x3c, { args: 1, run: c => c.readSpecial() }],
  ]);

  // ── Completion helpers ────────────────────────────────────────────────────

  /** Finish with a result after the settle delay, raising the interrupt. */
  private conclude(code: number): void {
    this.setDataReq(false);
    this.xfer = null;
    this.stage = 'busy';
    this.alarm = { left: SETTLE_CYCLES, fire: () => this.publish(code, true) };
  }

  /** Finish with an immediate result and no interrupt (the "simple" commands). */
  private answer(code: number): void {
    this.setDataReq(false);
    this.publish(code, false);
  }

  private publish(code: number, interrupt: boolean): void {
    this.result = code & 0xff;
    this.stage = 'result';
    this.setResultIrq(interrupt);
  }

  /** Finish a command that has no result byte. */
  private finishSilently(): void {
    this.setDataReq(false);
    this.motorOn = false;
    this.stage = 'idle';
  }

  private takeResult(): number {
    const value = this.result;
    if (this.stage === 'result') this.stage = 'idle';
    this.motorOn = false;
    this.setResultIrq(false);
    return value;
  }

  // ── Command helpers ───────────────────────────────────────────────────────

  private get unit(): number { return (this.cmd[0] >> 7) & 1; }
  private get side(): number { return (this.regs[REG_DRIVE_OUT] & OUT_SIDE) !== 0 ? 1 : 0; }

  /** Common start-up: remember the drive, light the motor, note the track the host named. */
  private engage(moveHead: boolean): number {
    const u = this.unit;
    this.currentDrive = u;
    this.motorOn = true;
    if (moveHead) this.regs[HEAD_REG[u]] = this.cmd[1];
    return u;
  }

  private trackFor(disk: DskImage) {
    return disk.tracks[this.cmd[1]]?.[this.side] ?? null;
  }

  /** The run of consecutive sectors a data command names, or null if one is absent. */
  private sectorRun(disk: DskImage): DskSector[] | null {
    const track = this.trackFor(disk);
    if (track === null) return null;
    const count = Math.max(1, this.cmd[3] & 0x1f);
    const run: DskSector[] = [];
    for (let i = 0; i < count; i++) {
      const id = (this.cmd[2] + i) & 0xff;
      const sector = track.sectors.find(s => s.r === id);
      if (sector === undefined) return null;
      run.push(sector);
    }
    return run;
  }

  private beginTransfer(x: Transfer): void {
    this.xfer = x;
    this.stage = 'transfer';
    this.alarm = { left: BYTE_CYCLES, fire: () => this.setDataReq(true) };
  }

  /** After a byte is serviced: ask for the next, or wrap the transfer up. */
  private advanceTransfer(x: Transfer): void {
    const more = x.at < x.bytes.length;
    this.alarm = {
      left: BYTE_CYCLES,
      fire: more ? () => this.setDataReq(true) : () => this.endTransfer(x),
    };
  }

  private endTransfer(x: Transfer): void {
    if (x.fromHost) {
      let at = 0;
      for (const sector of x.targets) {
        sector.data.set(x.bytes.subarray(at, at + sector.data.length));
        sector.copies = undefined;   // rewriting a sector erases any weak-bit variation
        at += sector.data.length;
      }
      this.written[x.unit] = true;
    }
    this.conclude(I8271Result.NONE);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private dataCommand(kind: 'read' | 'write' | 'verify'): void {
    const unit = this.engage(true);
    if (kind === 'write' && this.writeProtect[unit]) return this.conclude(I8271Result.WP);
    const disk = this.disks[unit];
    if (disk === null) return this.conclude(I8271Result.NR);
    const run = this.sectorRun(disk);
    if (run === null) return this.conclude(I8271Result.NF);
    if (kind === 'verify') return this.conclude(I8271Result.NONE);

    const total = run.reduce((n, s) => n + s.data.length, 0);
    if (kind === 'write') {
      this.beginTransfer({ bytes: new Uint8Array(total), at: 0, fromHost: true, targets: run, unit });
      return;
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const s of run) { bytes.set(s.data, at); at += s.data.length; }
    this.beginTransfer({ bytes, at: 0, fromHost: false, targets: [], unit });
  }

  /** READ ID: hand back the C, H, R, N of the next `count` sector headers on the track. */
  private readIds(): void {
    const unit = this.engage(true);
    const disk = this.disks[unit];
    if (disk === null) return this.conclude(I8271Result.NR);
    const sectors = this.trackFor(disk)?.sectors ?? [];
    if (sectors.length === 0) return this.conclude(I8271Result.NF);
    const count = Math.max(1, this.cmd[3] & 0x1f);
    const bytes = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      const s = sectors[i % sectors.length];
      bytes.set([s.c, s.h, s.r, s.n], i * 4);
    }
    this.beginTransfer({ bytes, at: 0, fromHost: false, targets: [], unit });
  }

  private formatTrack(): void {
    const unit = this.engage(true);
    if (this.writeProtect[unit]) return this.conclude(I8271Result.WP);
    const disk = this.disks[unit];
    if (disk === null) return this.conclude(I8271Result.NR);
    const track = this.trackFor(disk);
    if (track === null) return this.conclude(I8271Result.NF);
    for (const s of track.sectors) s.data.fill(ERASED);
    this.written[unit] = true;
    this.conclude(I8271Result.NONE);
  }

  private seek(): void {
    const unit = this.engage(false);
    if (this.disks[unit] === null) return this.conclude(I8271Result.NR);
    this.regs[HEAD_REG[unit]] = this.cmd[1];   // seeking to 0 is a recalibrate; both just move the head
    this.conclude(I8271Result.NONE);
  }

  private readDriveStatus(): void {
    const wants0 = (this.cmd[0] & SELECT_0) !== 0;
    const wants1 = (this.cmd[0] & SELECT_1) !== 0;
    const unit = wants1 ? 1 : 0;
    this.currentDrive = unit;

    let status = DRIVE_BIT7;
    if (wants1 && this.connected[1]) status |= DRIVE_1_READY;
    if (wants0 && this.connected[0]) status |= DRIVE_0_READY;
    if (this.connected[unit] && this.regs[HEAD_REG[unit]] === 0) status |= DRIVE_TRACK_0;
    if (this.writeProtect[unit]) status |= DRIVE_WRITE_PROT;
    this.answer(status);
  }

  private specify(): void {
    const [, mode, a, b, c] = this.cmd;
    if (mode === SPECIFY_TIMING) {
      this.timing[0] = a;          // step rate
      this.timing[1] = b;          // head settle
      this.timing[2] = c >> 4;     // index count
      this.timing[3] = c & 0x0f;   // head load
    } else if (mode === REG_BAD_TRACK_0 || mode === REG_BAD_TRACK_1) {
      this.regs[mode] = a;
      this.regs[mode + 1] = b;
      this.regs[HEAD_REG[(mode >> 3) & 1]] = c;
    }
    this.finishSilently();
  }

  private writeSpecial(): void {
    const reg = this.cmd[1];
    const value = this.cmd[2];
    if (reg === REG_MODE) {
      this.regs[REG_MODE] = value | MODE_FORCED;
      this.refreshLine();
    } else if (reg === REG_DRIVE_OUT) {
      this.regs[REG_DRIVE_OUT] = value & ~OUT_SELECT_BITS;
      const select = value & OUT_SELECT_BITS;
      if (select === SELECT_0) this.currentDrive = 0;
      else if (select === SELECT_1) this.currentDrive = 1;
      if ((value & OUT_HEAD_LOAD) !== 0) this.motorOn = true;
    } else if (VALID_REGS.has(reg)) {
      this.regs[reg] = value;
    }
    this.finishSilently();
  }

  private readSpecial(): void {
    const reg = this.cmd[1] & 0x3f;
    let value = VALID_REGS.has(reg) ? this.regs[reg] : 0;
    if (reg === REG_DRIVE_OUT) value |= this.cmd[0] & OUT_SELECT_BITS;
    this.answer(value);
  }
}
