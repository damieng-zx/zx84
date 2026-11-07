/**
 * The Commodore 1581 disk drive: a computer of its own, with a floppy
 * controller chip.
 *
 * A 6502 at 2 MHz, 8K of RAM, the 32K DOS ROM, a 6526 CIA that is the serial
 * (IEC) bus interface and the drive's control port, and a WD1770 floppy
 * controller for the 3.5" double-density disk. Unlike the 1541 it does not
 * read the media bit by bit itself: it gives the controller commands (seek,
 * read sector, write track) and moves the bytes through its data register.
 *
 *   $0000-$1FFF  RAM (mirrored to $3FFF)
 *   $4000-$5FFF  the CIA
 *   $6000-$7FFF  the WD1770: status/command, track, sector and data
 *   $8000-$FFFF  the DOS ROM
 *
 * CIA port A: bit 0 selects the side (low = side 0, the head the ID fields
 * call 0), bit 2 the motor (low = on), bit 6 the LED; bits 3-4 read the device number jumpers (open = 8) and
 * bit 7 reads low after the disk has been changed, until the head steps.
 * Port B is the bus: bits 0, 2 and 7 read DATA, CLK and ATN (a set bit is a
 * line held low), bits 1 and 3 pull DATA and CLK low, bit 4 (ATNA) makes the
 * hardware itself pull DATA low while ATN is held, which is how a drive
 * acknowledges ATN before the DOS has run an instruction, and bit 6 reads the
 * disk's write-protect tab (high = writable). ATN also reaches the CIA's FLAG
 * input, so the DOS is interrupted when the 64 asks for the bus.
 *
 * The controller is the shared WD177x model (`WD179x`): sector-level, with
 * the disk as a `DskImage`. It does not model a byte clock, so a transfer
 * runs as fast as the DOS can poll it.
 */

import { M6502 } from '@/cores/m6502.ts';
import { Mos6526 } from '@/cores/mos6526.ts';
import { WD179x } from '@/cores/wd179x.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { readDskImage, writeDskImage } from '@/media/floppy/disk-state.ts';
import { D81_SIZE, parseD81, serializeD81 } from '@/media/floppy/c64-d81.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import type { StateSink, StateSource } from '@/utils/state-stream.ts';
import type { C64DriveUnit } from './drive-unit.ts';

export const DRIVE_1581_CLOCK_HZ = 2_000_000;
export const DRIVE_1581_ROM_SIZE = 0x8000;

/** Cycles between the controller's 20 ms ticks (it spins its motor down after a second). */
const FDC_TICK_CYCLES = DRIVE_1581_CLOCK_HZ / 50;

export class Drive1581 implements C64DriveUnit {
  readonly model = '1581' as const;
  readonly clockHz = DRIVE_1581_CLOCK_HZ;
  readonly romSize = DRIVE_1581_ROM_SIZE;
  readonly cpu = new M6502();
  readonly ram = new Uint8Array(0x2000);
  readonly rom = new Uint8Array(DRIVE_1581_ROM_SIZE);
  readonly cia = new Mos6526();
  readonly fdc = new WD179x({ statusBit7: 'motor-on', formatSectorsPerTrack: 10, addressCrc: true });
  hasRom = false;
  unit = 0;

  mediaName = '';
  writeProtected = false;
  dirty = false;

  // The serial bus lines as the 64 holds them (true = pulled low).
  private atn = false;
  private c64Clk = false;
  private c64Data = false;

  /** The disk was changed and the head has not stepped since: PA7 reads low. */
  private changed = false;
  private fdcCycles = 0;
  /** Controller bytes moved since the last `takeActivity`. */
  private activity = 0;
  /** A restored controller state waiting for its disk to be mounted. */
  private pendingFdc: Uint8Array | null = null;

  constructor() {
    this.cpu.read = (addr) => this.busRead(addr);
    this.cpu.write = (addr, value) => this.busWrite(addr, value);
    this.fdc.pulseBusy = true;
    this.cia.portAIn = (driven) => this.portAPins(driven);
    this.cia.portBIn = (driven) => this.portBPins(driven);
    this.cia.onPortWrite = (port) => { if (port === 0) this.portAChanged(); };
  }

  // ── Power ───────────────────────────────────────────────────────────────

  /** Install the DOS ROM (the 32K image). */
  loadRom(data: Uint8Array): void {
    this.rom.fill(0xFF);
    this.rom.set(data.subarray(0, DRIVE_1581_ROM_SIZE));
    this.hasRom = data.length >= DRIVE_1581_ROM_SIZE;
    this.reset();
  }

  /** Power on: the ROM starts, the head stays where it was. */
  reset(): void {
    this.ram.fill(0);
    this.cia.reset();
    this.fdc.masterReset();
    this.atn = this.c64Clk = this.c64Data = false;
    this.fdcCycles = 0;
    this.activity = 0;
    this.cpu.reset();
    this.cia.now = this.cpu.tStates;
    this.portAChanged();
  }

  // ── Media ───────────────────────────────────────────────────────────────

  get loaded(): boolean { return this.fdc.getDiskImage(0) !== null; }

  mountImage(data: Uint8Array, name: string, silent = false): void {
    const image = parseD81(data);
    if (!image) {
      throw new Error(`a 1581 reads .d81 disks of ${D81_SIZE} bytes (this file is ${data.length})`);
    }
    this.putIn(image, name, silent);
  }

  insertImage(image: DskImage, name: string): void {
    if (image.numTracks !== 80 || image.numSides !== 2) throw new Error('not a Commodore 1581 disk');
    this.putIn(image, name, false);
  }

  private putIn(image: DskImage, name: string, silent: boolean): void {
    this.fdc.insertDisk(image, 0);
    this.fdc.writeProtect[0] = this.writeProtected;
    this.mediaName = name;
    this.dirty = false;
    if (!silent) this.changed = true;
    this.applyPendingFdc();
  }

  ejectDisk(): void {
    this.fdc.ejectDisk(0);
    this.mediaName = '';
    this.dirty = false;
    this.changed = true;
  }

  setWriteProtect(on: boolean): void {
    this.writeProtected = on;
    this.fdc.writeProtect[0] = on;
    this.changed = true;
  }

  saveImage(): { data: Uint8Array; ext: string } | null {
    const image = this.fdc.getDiskImage(0);
    if (!image) return null;
    const data = serializeD81(image);
    if (!data) throw new Error('this disk no longer has the 1581 layout (80 tracks of 10 sectors, both sides), so it cannot be saved as a .d81');
    this.dirty = false;
    return { data, ext: '.d81' };
  }

  diskImage(): DskImage | null { return this.fdc.getDiskImage(0); }

  // ── Serial bus ──────────────────────────────────────────────────────────

  /** Tell the drive what the 64 is holding low on the bus. ATN is also the
   *  CIA's FLAG: asserting it is a falling edge. */
  setC64Lines(atn: boolean, clk: boolean, data: boolean): void {
    this.c64Clk = clk;
    this.c64Data = data;
    if (atn !== this.atn) {
      this.atn = atn;
      if (atn) { this.cia.advanceTo(this.cpu.tStates); this.cia.flag(); }
    }
  }

  /** CIA port B bits the DOS drives: DATA out 1, CLK out 3, ATNA 4. */
  private get iecOut(): number { return this.cia.prb & this.cia.ddrb; }

  /** The drive pulls CLK low. */
  get clkAsserted(): boolean { return (this.iecOut & 0x08) !== 0; }

  /** The drive pulls DATA low: the DOS has set DATA OUT, or ATNA is set while
   *  ATN is held (the hardware acknowledges ATN by itself). */
  get dataAsserted(): boolean {
    const out = this.iecOut;
    return (out & 0x02) !== 0 || ((out & 0x10) !== 0 && this.atn);
  }

  // ── CIA pins ────────────────────────────────────────────────────────────

  private portAPins(driven: number): number {
    // Inputs: the device-number jumpers (PA3-4: device 8 + unit) and "disk not changed".
    const inputs = (this.changed ? 0x00 : 0x80) | ((this.unit & 3) << 3);
    const out = this.cia.ddra;
    return ((driven & out) | (inputs & ~out)) & 0xFF;
  }

  private portBPins(driven: number): number {
    let inputs = 0;
    if (this.c64Data || this.dataAsserted) inputs |= 0x01;
    if (this.c64Clk || this.clkAsserted) inputs |= 0x04;
    if (!this.writeProtected) inputs |= 0x40;
    if (this.atn) inputs |= 0x80;
    const out = this.cia.ddrb;
    return ((driven & out) | (inputs & ~out)) & 0xFF;
  }

  /** Port A: side, motor and LED follow what the DOS wrote. */
  private portAChanged(): void {
    const pins = this.cia.drivenA;
    this.fdc.setSide((pins & 0x01) !== 0 ? 1 : 0);
  }

  /** PA2 low runs the spindle motor. */
  get motorOn(): boolean { return (this.cia.drivenA & 0x04) === 0; }
  get ledOn(): boolean { return (this.cia.drivenA & 0x40) !== 0; }
  get isWriting(): boolean { return this.fdc.isWriting; }
  get currentHalfTrack(): number { return this.fdc.currentTrack * 2; }
  get currentTrack(): number { return this.fdc.currentTrack + 1; }

  /** Bytes moved to or from the controller since the last call. */
  takeActivity(): number {
    const n = this.activity;
    this.activity = 0;
    return n;
  }

  // ── Bus ─────────────────────────────────────────────────────────────────

  private busRead(addr: number): number {
    if (addr & 0x8000) return this.rom[addr & 0x7FFF];
    if (addr < 0x4000) return this.ram[addr & 0x1FFF];
    if (addr < 0x6000) {
      this.cia.advanceTo(this.cpu.tStates);
      return this.cia.read(addr);
    }
    if (addr < 0x8000) return this.fdcRead(addr & 3);
    return 0xFF;
  }

  private busWrite(addr: number, value: number): void {
    if (addr < 0x4000) { this.ram[addr & 0x1FFF] = value; return; }
    if (addr < 0x6000) {
      this.cia.advanceTo(this.cpu.tStates);
      this.cia.write(addr, value);
      return;
    }
    if (addr < 0x8000) this.fdcWrite(addr & 3, value);
  }

  private fdcRead(reg: number): number {
    switch (reg) {
      case 0: return this.fdc.readStatus();
      case 1: return this.fdc.readTrack();
      case 2: return this.fdc.readSectorReg();
      default: this.activity++; return this.fdc.readData();
    }
  }

  private fdcWrite(reg: number, value: number): void {
    switch (reg) {
      case 0:
        // The head stepping clears the disk-change latch; a restore from track
        // 0 sends no step pulse, so the DOS's start-up self-test leaves it set.
        {
          const before = this.fdc.currentTrack;
          this.fdc.writeCommand(value);
          if ((value & 0x80) === 0 && this.fdc.currentTrack !== before) this.changed = false;
        }
        if (this.fdc.isWriting) this.dirty = true;
        break;
      case 1: this.fdc.writeTrack(value); break;
      case 2: this.fdc.writeSectorReg(value); break;
      default:
        this.activity++;
        this.fdc.writeData(value);
        if (this.fdc.isWriting) this.dirty = true;
        break;
    }
  }

  // ── Running ─────────────────────────────────────────────────────────────

  /** Run the drive until its clock reaches `target` cycles. */
  runTo(target: number): void {
    if (!this.hasRom) return;
    const { cpu, cia } = this;
    while (cpu.tStates < target) {
      cpu.setIRQ(cia.irq);
      const before = cpu.tStates;
      cpu.step();
      cia.advanceTo(cpu.tStates);
      this.fdcCycles += cpu.tStates - before;
      if (this.fdcCycles >= FDC_TICK_CYCLES) {
        this.fdcCycles -= FDC_TICK_CYCLES;
        this.fdc.tickFrame();
      }
    }
  }

  get cycles(): number { return this.cpu.tStates; }

  // ── Debugger ────────────────────────────────────────────────────────────

  describe(): string[] {
    const hx = (v: number, w = 2): string => v.toString(16).toUpperCase().padStart(w, '0');
    const c = this.cia;
    const f = this.fdc;
    return [
      'CIA bus interface and control port ($4000)',
      `  PRA ${hx(c.pra)} DDRA ${hx(c.ddra)}  pins ${hx(c.drivenA)}   side ${(c.drivenA & 1) ? 1 : 0}  motor ${this.motorOn ? 'on' : 'off'}  LED ${this.ledOn ? 'on' : 'off'}  disk-change ${this.changed ? 'set' : 'clear'}`,
      `  PRB ${hx(c.prb)} DDRB ${hx(c.ddrb)}   TA ${hx(c.ta.counter, 4)}/${hx(c.ta.latch, 4)} ctl ${hx(c.ta.control)}   TB ${hx(c.tb.counter, 4)}/${hx(c.tb.latch, 4)} ctl ${hx(c.tb.control)}`,
      `  ICR flags ${hx(c.icrFlags)} mask ${hx(c.icrMask)}  ${c.irq ? 'IRQ asserted' : ''}`.trimEnd(),
      'WD1770 floppy controller ($6000)',
      `  track ${hx(f.trackReg)}  sector ${hx(f.sectorReg)}  head cylinder ${f.currentTrack}  side ${f.side}  motor ${f.motorOn ? 'on' : 'off'}`,
    ];
  }

  // ── Snapshot ────────────────────────────────────────────────────────────

  /** The drive between instructions. The disk is saved separately. */
  saveState(w: StateSink): void {
    this.cpu.saveState(w);
    w.raw(this.ram);
    this.cia.saveState(w);
    w.bool(this.atn); w.bool(this.c64Clk); w.bool(this.c64Data);
    w.bool(this.changed); w.u32(this.fdcCycles);
    // The controller's own state goes in a parcel: it needs the disk mounted
    // before it can be read back.
    const sub = new StateWriter();
    this.fdc.saveState(sub);
    w.bytes(sub.finish());
  }

  loadState(r: StateSource): void {
    this.cpu.loadState(r);
    r.rawInto(this.ram);
    this.cia.loadState(r);
    this.atn = r.bool(); this.c64Clk = r.bool(); this.c64Data = r.bool();
    this.changed = r.bool(); this.fdcCycles = r.u32();
    this.pendingFdc = r.bytes(1 << 20);
    if (this.loaded) this.applyPendingFdc();
  }

  private applyPendingFdc(): void {
    if (!this.pendingFdc) return;
    const bytes = this.pendingFdc;
    this.pendingFdc = null;
    this.fdc.loadState(new StateReader(bytes));
    this.portAChanged();
  }

  /** The disk with everything written to it, for the snapshot's media section. */
  saveDisk(w: StateSink): void {
    const image = this.fdc.getDiskImage(0);
    w.bool(image !== null);
    if (!image) return;
    w.str(this.mediaName);
    w.bool(this.writeProtected);
    w.bool(this.dirty);
    writeDskImage(w, image);
  }

  loadDisk(r: StateSource): void {
    if (!r.bool()) {
      this.fdc.ejectDisk(0);
      this.mediaName = '';
      this.dirty = false;
      this.applyPendingFdc();
      return;
    }
    this.mediaName = r.str();
    this.writeProtected = r.bool();
    const dirty = r.bool();
    this.fdc.insertDisk(readDskImage(r), 0);
    this.fdc.writeProtect[0] = this.writeProtected;
    this.dirty = dirty;
    this.applyPendingFdc();
  }
}
