/**
 * The Commodore 1541 disk drive: a computer of its own.
 *
 * Inside the case sit a 6502 at 1 MHz, 2K of RAM, the 16K DOS ROM and two 6522
 * VIAs. VIA 1 is the serial (IEC) bus interface; VIA 2 is the disk controller.
 * There is no floppy controller chip: the DOS finds sync, reads and writes the
 * GCR bytes itself, with only a little hardware to help:
 *
 *  - Rotation. The disk turns at 300 rpm while the motor (VIA 2 port B bit 2)
 *    is on, and the bits of the track under the head pass at one of four
 *    rates, chosen by port B bits 5-6 (the speed zone). A bit cell is 3.25 to
 *    4 CPU cycles, so a byte is 26 to 32.
 *  - Head. The stepper (port B bits 0-1) moves the head one half-track each
 *    time the 2-bit phase counts up or down by one.
 *  - Sync. Ten or more 1 bits in a row are sync: port B bit 7 reads low and
 *    the bit counter is held at zero, so the first bit after it starts a byte.
 *  - Byte ready. Every eight bits outside sync a byte is complete: it is
 *    latched onto port A, CA1 sees a falling edge and, if CA2 is held high
 *    (SOE), the CPU's overflow flag is set. The DOS polls it with `BVC *`.
 *  - Write. With CB2 held low the same eight-bit cycle runs the other way:
 *    each byte written to port A is shifted out to the head, one bit per cell,
 *    on the next byte boundary.
 *  - Serial bus. Port B bits 0/2/7 read DATA, CLK and ATN, inverted (a set bit
 *    is a line held low); bits 1 and 3 pull DATA and CLK low; bit 4 (ATNA)
 *    against ATN decides whether the hardware itself holds DATA low, which is
 *    how a drive acknowledges ATN within a microsecond, before the DOS has
 *    run a single instruction.
 *
 * The drive is brought up to the computer's time on demand (`runTo`), at
 * every access the computer makes to the bus and at the end of each frame.
 * It serves any Commodore with a serial bus (the C64, the VIC-20).
 */

import { M6502, FLAG_V } from '@/cores/m6502.ts';
import { M6522 } from '@/cores/m6522.ts';
import {
  C64_HALF_TRACKS, readC64Disk, speedZone, TRACK_BYTES_BY_ZONE, writeC64Disk, type C64Disk, type C64Track,
} from '@/media/floppy/c64-disk.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import {
  c64DiskImage, isC64DiskImage, parseC64Disk, serializeC64Disk,
} from '@/media/floppy/c64-disk.ts';
import type { StateSink, StateSource } from '@/utils/state-stream.ts';
import type { CbmDriveModel, CbmDriveUnit } from './drive-unit.ts';

export const DRIVE_CLOCK_HZ = 1_000_000;
export const DRIVE_ROM_SIZE = 0x4000;

/** Quarter cycles per bit cell for speed zones 0-3 (8 bits in 32/30/28/26 cycles). */
const BIT_QUARTERS = [16, 15, 14, 13] as const;
/** After a disk is put in or taken out the write-protect sensor reads the
 *  opposite of its final value this long, so the DOS sees the change however
 *  the two disks' tabs compare. */
const SENSOR_FLIP_CYCLES = 40_000;

export class Drive1541 implements CbmDriveUnit {
  readonly model: CbmDriveModel = '1541';
  readonly clockHz: number = DRIVE_CLOCK_HZ;
  readonly romSize: number = DRIVE_ROM_SIZE;
  readonly cpu = new M6502();
  readonly ram = new Uint8Array(0x800);
  /** The DOS ROM; the 1571, which builds on this class, has twice the size. */
  rom: Uint8Array = new Uint8Array(DRIVE_ROM_SIZE);
  readonly via1 = new M6522();
  readonly via2 = new M6522();
  hasRom = false;
  unit = 0;

  disk: C64Disk | null = null;
  /** The file the disk came from, for the Drives pane and for saving. */
  mediaName = '';
  writeProtected = false;
  /** The mounted disk has been written to since it was put in or saved. */
  dirty = false;

  // The serial bus lines as the computer holds them (true = pulled low).
  protected atn = false;
  protected hostClk = false;
  protected hostData = false;

  // Mechanics.
  protected halfTrack = 34;
  protected track: C64Track | null = null;
  protected bitPos = 0;
  protected quarters = 0;
  protected motor = false;
  protected led = false;
  protected zone = 0;
  protected lastPhase = 0;
  protected sensorFlipUntil = 0;
  /** How long the sensor flips for, in this drive's own clock ticks. */
  protected sensorFlipCycles = SENSOR_FLIP_CYCLES;

  // Read/write head electronics.
  protected syncShift = 0;
  protected shiftReg = 0;
  protected bitCount = 0;
  protected inSync = false;
  protected writeShift = 0x55;
  protected writing = false;

  /** Bytes the controller has moved since the last `takeActivity`. */
  protected activity = 0;
  /** A byte has come off the head since the DOS last read port A (the 1571 can
   *  read this on VIA 1). */
  protected byteReady = false;

  constructor() {
    this.cpu.read = (addr) => this.busRead(addr);
    this.cpu.write = (addr, value) => this.busWrite(addr, value);
  }

  // ── Power ───────────────────────────────────────────────────────────────

  /** Install the DOS ROM (the 16K image: 325302-01 at $C000, 901229-xx at $E000). */
  loadRom(data: Uint8Array): void {
    this.rom.fill(0xFF);
    this.rom.set(data.subarray(0, this.romSize));
    this.hasRom = data.length >= this.minRomSize;
    this.reset();
  }

  /** The least a ROM image may be and still start (a 1541 takes the 8K of the
   *  later single-ROM images). */
  protected get minRomSize(): number { return 0x2000; }

  /** Power on: the ROM starts, the head stays where it was. */
  reset(): void {
    this.ram.fill(0);
    this.via1.reset();
    this.via2.reset();
    this.motor = this.led = false;
    this.zone = 0;
    this.lastPhase = 0;
    this.syncShift = this.shiftReg = this.bitCount = 0;
    this.inSync = false;
    this.writing = false;
    this.writeShift = 0x55;
    this.quarters = 0;
    this.sensorFlipUntil = 0;
    this.activity = 0;
    this.byteReady = false;
    this.atn = this.hostClk = this.hostData = false;
    this.cpu.reset();
  }

  // ── Media ───────────────────────────────────────────────────────────────

  get loaded(): boolean { return this.disk !== null; }

  mountImage(data: Uint8Array, name: string, silent = false): void {
    let disk: C64Disk;
    try {
      disk = parseC64Disk(data);
    } catch (e) {
      throw new Error(`a 1541 reads .d64 and .g64 disks (${e instanceof Error ? e.message : String(e)})`);
    }
    this.insertDisk(disk, this.writeProtected, name, silent);
  }

  insertImage(image: DskImage, name: string): void {
    if (!isC64DiskImage(image)) throw new Error('not a Commodore 1541 disk');
    this.insertDisk(image.c64, this.writeProtected, name);
  }

  saveImage(): { data: Uint8Array; ext: string } | null {
    if (!this.disk) return null;
    const out = serializeC64Disk(this.disk);
    this.dirty = false;
    return out;
  }

  diskImage(): DskImage | null { return this.disk ? c64DiskImage(this.disk) : null; }

  describe(): string[] {
    const hx = (v: number, w = 2): string => v.toString(16).toUpperCase().padStart(w, '0');
    const via = (v: M6522): string[] => [
      `  ORA ${hx(v.ora)} DDRA ${hx(v.ddra)}   ORB ${hx(v.orb)} DDRB ${hx(v.ddrb)}   ACR ${hx(v.acr)}  PCR ${hx(v.pcr)}`,
      `  T1 ${hx(v.t1Counter, 4)} (latch ${hx(v.t1Latch, 4)}${v.t1Running ? ', running' : ''})   T2 ${hx(v.t2Counter, 4)}${v.t2Running ? ' (running)' : ''}   SR ${hx(v.sr)}`,
      `  IFR ${hx(v.ifr)}  IER ${hx(v.ier)}  ${v.irq ? 'IRQ asserted' : ''}`.trimEnd(),
    ];
    return [
      'VIA 1 serial bus / ATN, clock, data ($1800)',
      ...via(this.via1),
      'VIA 2 disk controller ($1C00)',
      ...via(this.via2),
    ];
  }

  /** Put a disk in. `silent` swaps the disk without the write-protect sensor
   *  flickering, for putting back the disk a restored snapshot already had. */
  insertDisk(disk: C64Disk, writeProtected = false, name = '', silent = false): void {
    this.disk = disk;
    this.mediaName = name;
    this.writeProtected = writeProtected;
    this.dirty = false;
    if (!silent) this.sensorFlipUntil = this.cpu.tStates + this.sensorFlipCycles;
    this.seatTrack();
  }

  ejectDisk(): void {
    this.disk = null;
    this.mediaName = '';
    this.dirty = false;
    this.sensorFlipUntil = this.cpu.tStates + this.sensorFlipCycles;
    this.seatTrack();
  }

  setWriteProtect(on: boolean): void {
    this.writeProtected = on;
    this.sensorFlipUntil = this.cpu.tStates + this.sensorFlipCycles;
  }

  /** The track under the head after the head or the disk changed. */
  /** The half-tracks under the head: a 1571's second side has its own. */
  protected get trackSet(): (C64Track | null)[] | null {
    return this.disk?.tracks ?? null;
  }

  protected seatTrack(): void {
    const next = this.trackSet?.[this.halfTrack] ?? null;
    const old = this.track;
    if (old && next && old.length !== next.length) {
      this.bitPos = Math.floor(this.bitPos * next.length / old.length);
    }
    if (next && this.bitPos >= next.length) this.bitPos %= next.length;
    this.track = next;
  }

  // ── Serial bus ──────────────────────────────────────────────────────────

  /** Tell the drive what the computer is holding low on the bus. ATN reaches VIA 1's
   *  CA1 inverted, so asserting it is a rising edge. */
  setHostLines(atn: boolean, clk: boolean, data: boolean): void {
    this.hostClk = clk;
    this.hostData = data;
    if (atn !== this.atn) {
      this.atn = atn;
      this.via1.setCA1(atn);
    }
  }

  /** VIA 1 port B bits the DOS drives: DATA out 1, CLK out 3, ATNA 4. */
  protected get iecOut(): number { return this.via1.orb & this.via1.ddrb; }

  /** The drive pulls CLK low. */
  get clkAsserted(): boolean { return (this.iecOut & 0x08) !== 0; }

  /** The drive pulls DATA low: the DOS has set DATA OUT, or ATN and ATNA
   *  disagree (the hardware acknowledges ATN by itself). */
  get dataAsserted(): boolean {
    const out = this.iecOut;
    return (out & 0x02) !== 0 || this.atn !== ((out & 0x10) !== 0);
  }

  // ── Bus ─────────────────────────────────────────────────────────────────

  protected via1Pins(): number {
    let v = (this.unit & 3) << 5;               // PB5/PB6: the device number, 8 + unit
    if (this.hostData || this.dataAsserted) v |= 0x01;
    if (this.hostClk || this.clkAsserted) v |= 0x04;
    if (this.atn) v |= 0x80;
    return v;
  }

  protected via2Pins(): number {
    let v = 0x6F;
    if (!this.inSync) v |= 0x80;                // SYNC reads low while in sync
    if (this.sensorWritable()) v |= 0x10;
    return v;
  }

  /** Write-protect sensor: set when a disk without a protect tab is in. */
  protected sensorWritable(): boolean {
    const writable = this.disk !== null && !this.writeProtected;
    return this.cpu.tStates < this.sensorFlipUntil ? !writable : writable;
  }

  protected busRead(addr: number): number {
    addr &= 0xFFFF;
    if (addr & 0x8000) return this.rom[addr & 0x3FFF];
    if (addr < 0x1800) return this.ram[addr & 0x7FF];
    if (addr < 0x1C00) {
      this.via1.portBInput = this.via1Pins();
      return this.via1.read(addr & 0x0F);
    }
    if (addr < 0x2000) {
      this.via2.portBInput = this.via2Pins();
      if ((addr & 0x0F) <= 1 || (addr & 0x0F) === 0x0F) this.byteReady = false;     // ORB, ORA
      return this.via2.read(addr & 0x0F);
    }
    return 0xFF;
  }

  protected busWrite(addr: number, value: number): void {
    addr &= 0xFFFF;
    if (addr < 0x1800) { this.ram[addr & 0x7FF] = value; return; }
    if (addr < 0x1C00) { this.via1.write(addr & 0x0F, value); return; }
    if (addr < 0x2000) {
      const reg = addr & 0x0F;
      this.via2.write(reg, value);
      if (reg <= 1 || reg === 15) this.byteReady = false;
      if (reg === 0 || reg === 2) this.updateMechanics();
      if (reg === 1 || reg === 15) this.activity++;
    }
  }

  // ── Mechanics ───────────────────────────────────────────────────────────

  /** Follow VIA 2 port B: stepper phase, motor, LED and speed zone. */
  protected updateMechanics(): void {
    const via = this.via2;
    const out = via.orb & via.ddrb;
    if ((via.ddrb & 0x03) === 0x03) {
      const phase = out & 3;
      if (phase !== this.lastPhase) {
        const delta = (phase - this.lastPhase) & 3;
        if (delta === 1) this.stepHead(1);
        else if (delta === 3) this.stepHead(-1);
        this.lastPhase = phase;
      }
    }
    if (via.ddrb & 0x04) this.motor = (out & 0x04) !== 0;
    if (via.ddrb & 0x08) this.led = (out & 0x08) !== 0;
    if ((via.ddrb & 0x60) === 0x60) this.zone = (out >> 5) & 3;
  }

  protected stepHead(dir: number): void {
    const next = Math.min(C64_HALF_TRACKS - 1, Math.max(0, this.halfTrack + dir));
    if (next === this.halfTrack) return;
    this.halfTrack = next;
    this.seatTrack();
  }

  get currentHalfTrack(): number { return this.halfTrack; }
  /** The track number (1-based) the head is over, as the pane shows it. */
  get currentTrack(): number { return (this.halfTrack >> 1) + 1; }
  get motorOn(): boolean { return this.motor; }
  get ledOn(): boolean { return this.led; }
  get isWriting(): boolean { return this.writing && this.motor; }

  /** Bytes moved to or from the head since the last call. */
  takeActivity(): number {
    const n = this.activity;
    this.activity = 0;
    return n;
  }

  /** Turn the disk for `cycles` CPU cycles, bit cell by bit cell. */
  protected advanceHead(cycles: number): void {
    this.advanceQuarters(cycles * 4);
  }

  /** The same, in quarters of a CPU cycle at 1 MHz (a 1571 at 2 MHz sees half as many). */
  protected advanceQuarters(quarters: number): void {
    if (!this.motor) return;
    this.quarters += quarters;
    let cell = BIT_QUARTERS[this.zone];
    while (this.quarters >= cell) {
      this.quarters -= cell;
      this.clockBit();
      cell = BIT_QUARTERS[this.zone];
    }
  }

  protected clockBit(): void {
    let track = this.track;
    this.writing = (this.via2.pcr & 0xE0) === 0xC0;     // CB2 held low
    if (this.writing) {
      // Writing on a track the image does not have formats it, as it would on a real disk.
      if (!track && this.disk && !this.writeProtected) track = this.createTrack();
      const bit = (this.writeShift >> 7) & 1;
      this.writeShift = (this.writeShift << 1) & 0xFF;
      if (track && !this.writeProtected) {
        const at = this.bitPos;
        const mask = 0x80 >> (at & 7);
        if (bit) track.bits[at >> 3] |= mask;
        else track.bits[at >> 3] &= ~mask;
        this.dirty = true;
      }
      this.syncShift = 0;
      this.inSync = false;
      if (++this.bitCount === 8) {
        this.bitCount = 0;
        this.writeShift = this.via2.ora & 0xFF;
        this.byteSignal();
      }
    } else {
      const bit = track ? (track.bits[this.bitPos >> 3] >> (7 - (this.bitPos & 7))) & 1 : 0;
      this.syncShift = ((this.syncShift << 1) | bit) & 0x3FF;
      this.shiftReg = ((this.shiftReg << 1) | bit) & 0xFF;
      if (this.syncShift === 0x3FF) {
        this.inSync = true;
        this.bitCount = 0;
      } else {
        this.inSync = false;
        if (++this.bitCount === 8) {
          this.bitCount = 0;
          this.via2.portAInput = this.shiftReg;
          this.writeShift = 0x55;
          this.byteSignal();
        }
      }
    }
    if (track && ++this.bitPos >= track.length) this.bitPos = 0;
  }

  /** A new, empty track under the head, for the DOS to format. */
  protected createTrack(): C64Track | null {
    const set = this.trackSet;
    if (!set) return null;
    const zone = speedZone((this.halfTrack >> 1) + 1);
    const bytes = TRACK_BYTES_BY_ZONE[zone];
    const track: C64Track = { bits: new Uint8Array(bytes), length: bytes * 8, zone };
    set[this.halfTrack] = track;
    this.track = track;
    this.bitPos = 0;
    return track;
  }

  /** A byte boundary: CA1 falls, and with CA2 held high the overflow flag is set. */
  protected byteSignal(): void {
    this.byteReady = true;
    this.activity++;
    this.via2.setCA1(true);
    this.via2.setCA1(false);
    if (((this.via2.pcr >> 1) & 7) === 7) this.cpu.p |= FLAG_V;
  }

  // ── Running ─────────────────────────────────────────────────────────────

  /** Run the drive until its clock reaches `target` cycles. */
  runTo(target: number): void {
    if (!this.hasRom) return;
    const { cpu, via1, via2 } = this;
    while (cpu.tStates < target) {
      cpu.setIRQ(via1.irq || via2.irq);
      const before = cpu.tStates;
      cpu.step();
      const n = cpu.tStates - before;
      via1.addCycles(n);
      via2.addCycles(n);
      this.advanceHead(n);
    }
  }

  get cycles(): number { return this.cpu.tStates; }

  // ── Snapshot ────────────────────────────────────────────────────────────

  /** The drive between instructions. The disk is saved separately. */
  saveState(w: StateSink): void {
    this.cpu.saveState(w);
    w.raw(this.ram);
    this.via1.saveState(w);
    this.via2.saveState(w);
    w.bool(this.atn); w.bool(this.hostClk); w.bool(this.hostData);
    w.u8(this.halfTrack); w.u32(this.bitPos); w.u32(this.quarters);
    w.bool(this.motor); w.bool(this.led); w.u8(this.zone); w.u8(this.lastPhase);
    w.f64(this.sensorFlipUntil);
    w.u16(this.syncShift); w.u8(this.shiftReg); w.u8(this.bitCount);
    w.bool(this.inSync); w.u8(this.writeShift); w.bool(this.writing);
  }

  loadState(r: StateSource): void {
    this.cpu.loadState(r);
    r.rawInto(this.ram);
    this.via1.loadState(r);
    this.via2.loadState(r);
    this.atn = r.bool(); this.hostClk = r.bool(); this.hostData = r.bool();
    this.halfTrack = r.u8(); this.bitPos = r.u32(); this.quarters = r.u32();
    this.motor = r.bool(); this.led = r.bool(); this.zone = r.u8() & 3; this.lastPhase = r.u8() & 3;
    this.sensorFlipUntil = r.f64();
    this.syncShift = r.u16(); this.shiftReg = r.u8(); this.bitCount = r.u8();
    this.inSync = r.bool(); this.writeShift = r.u8(); this.writing = r.bool();
    this.seatTrack();
  }

  /** The disk with everything written to it, for the snapshot's media section. */
  saveDisk(w: StateSink): void {
    w.bool(this.disk !== null);
    if (!this.disk) return;
    w.str(this.mediaName);
    w.bool(this.writeProtected);
    w.bool(this.dirty);
    writeC64Disk(w, this.disk);
  }

  loadDisk(r: StateSource): void {
    if (!r.bool()) { this.disk = null; this.mediaName = ''; this.dirty = false; this.seatTrack(); return; }
    this.mediaName = r.str();
    this.writeProtected = r.bool();
    const dirty = r.bool();
    this.disk = readC64Disk(r);
    this.dirty = dirty;
    this.seatTrack();
  }
}
