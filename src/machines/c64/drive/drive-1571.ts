/**
 * The Commodore 1571 disk drive: a 1541 with a second head, a faster clock and
 * a few chips for the C128.
 *
 * The disk part is the 1541's own (two 6522 VIAs, the GCR electronics, the
 * stepper), so this class builds on `Drive1541`. What the 1571 adds:
 *
 *  - A second head. VIA 1 port A bit 2 picks the side; the same 35 cylinders
 *    carry tracks 1-35 on side 0 and tracks 36-70 on side 1 (`.d71`).
 *  - A 2 MHz clock. VIA 1 port A bit 5 doubles the 6502's speed; the disk
 *    turns at the same speed whatever the clock, so a bit cell then takes twice
 *    as many CPU cycles. The drive's time here is counted in ticks of 2 MHz
 *    either way: a CPU cycle takes two of them at 1 MHz, one at 2 MHz.
 *  - More VIA 1 port A pins: bit 0 reads the track-0 sensor (low at track 1),
 *    bit 7 reads the byte-ready latch (low while a byte is waiting), bit 1
 *    picks the direction of the fast serial bus.
 *  - A 32K DOS ROM at $8000, a 6526 CIA at $4000 (the C128's fast serial
 *    bus; nothing on the 64 reaches it) and a WD1770 at $2000 (MFM disks, for
 *    CP/M; there is no MFM disk to put in it here).
 *
 *   $0000-$17FF  RAM (2K, mirrored), $1800 VIA 1 (bus), $1C00 VIA 2 (disk)
 *   $2000-$2FFF  the WD1770      $4000-$7FFF  the CIA      $8000-$FFFF  the DOS ROM
 *
 * On the 64 it answers the serial bus as a 1541 does; the DOS recognises the
 * disk by its BAM, so a `.d64` works as it would in a 1541.
 */

import { Mos6526 } from '@/cores/mos6526.ts';
import { WD179x } from '@/cores/wd179x.ts';
import {
  C64_HALF_TRACKS, parseC64Disk71, type C64Disk, type C64Track,
} from '@/media/floppy/c64-disk.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import type { StateSink, StateSource } from '@/utils/state-stream.ts';
import { Drive1541 } from './drive-1541.ts';
import type { C64DriveModel } from './drive-unit.ts';

/** The drive's time base: ticks of its fastest clock. */
export const DRIVE_1571_BASE_HZ = 2_000_000;
export const DRIVE_1571_ROM_SIZE = 0x8000;

/** Ticks between the controller's 20 ms steps. */
const FDC_TICK_CYCLES = DRIVE_1571_BASE_HZ / 50;

export class Drive1571 extends Drive1541 {
  override readonly model: C64DriveModel = '1571';
  override readonly clockHz: number = DRIVE_1571_BASE_HZ;
  override readonly romSize: number = DRIVE_1571_ROM_SIZE;
  readonly cia = new Mos6526();
  readonly fdc = new WD179x({ statusBit7: 'motor-on', formatSectorsPerTrack: 10 });

  /** The head that is reading: 0 or 1. */
  protected side = 0;
  /** The 6502 is running at 2 MHz. */
  protected fast = false;
  /** Ticks added so far for the slow clock's second tick of each cycle, so the
   *  CPU's own cycle count is `cpu.tStates - stall`. */
  protected stall = 0;
  protected fdcTicks = 0;

  constructor() {
    super();
    this.rom = new Uint8Array(DRIVE_1571_ROM_SIZE);
    this.sensorFlipCycles *= 2;
  }

  /** The 6502's actual speed now, in Hz (the drive's time base is the faster one). */
  get cpuHz(): number { return this.fast ? 2_000_000 : 1_000_000; }

  protected override get minRomSize(): number { return DRIVE_1571_ROM_SIZE; }

  // ── Power ───────────────────────────────────────────────────────────────

  override reset(): void {
    super.reset();
    this.cia.reset();
    this.fdc.masterReset();
    this.side = 0;
    this.fast = false;
    this.stall = 0;
    this.fdcTicks = 0;
    this.cia.now = 0;
    this.seatTrack();
  }

  // ── Media ───────────────────────────────────────────────────────────────

  override mountImage(data: Uint8Array, name: string, silent = false): void {
    let disk: C64Disk;
    try {
      disk = parseC64Disk71(data);
    } catch (e) {
      throw new Error(`a 1571 reads .d71, .d64 and .g64 disks (${e instanceof Error ? e.message : String(e)})`);
    }
    this.insertDisk(disk, this.writeProtected, name, silent);
  }

  protected override get trackSet(): (C64Track | null)[] | null {
    if (!this.disk) return null;
    return this.side === 1 ? this.disk.tracks1 ?? null : this.disk.tracks;
  }

  protected override createTrack(): C64Track | null {
    if (this.side === 1 && this.disk && !this.disk.tracks1) {
      this.disk.tracks1 = new Array(C64_HALF_TRACKS).fill(null);
    }
    return super.createTrack();
  }

  // ── Bus ─────────────────────────────────────────────────────────────────

  /** The CPU's own cycle count, which the CIA counts. */
  private get cpuCycles(): number { return this.cpu.tStates - this.stall; }

  /** VIA 1 port A: the track-0 sensor, the byte-ready latch and the outputs the DOS drives. */
  private via1PortA(): number {
    return (this.byteReady ? 0x00 : 0x80) | (this.halfTrack === 0 ? 0x00 : 0x01);
  }

  protected override busRead(addr: number): number {
    addr &= 0xFFFF;
    if (addr & 0x8000) return this.rom[addr & 0x7FFF];
    if (addr >= 0x1800 && addr < 0x1C00) {
      this.via1.portAInput = this.via1PortA();
      this.via1.portBInput = this.via1Pins();
      return this.via1.read(addr & 0x0F);
    }
    if (addr < 0x2000) return super.busRead(addr);
    if (addr < 0x3000) return this.fdcRead(addr & 3);
    if (addr >= 0x4000 && addr < 0x8000) {
      this.cia.advanceTo(this.cpuCycles);
      return this.cia.read(addr);
    }
    return 0xFF;
  }

  protected override busWrite(addr: number, value: number): void {
    addr &= 0xFFFF;
    if (addr >= 0x1800 && addr < 0x1C00) {
      const reg = addr & 0x0F;
      this.via1.write(reg, value);
      if (reg === 1 || reg === 3 || reg === 15) this.updateOutputs();
      return;
    }
    if (addr < 0x2000) { super.busWrite(addr, value); return; }
    if (addr < 0x3000) { this.fdcWrite(addr & 3, value); return; }
    if (addr >= 0x4000 && addr < 0x8000) {
      this.cia.advanceTo(this.cpuCycles);
      this.cia.write(addr, value);
    }
  }

  /** Follow VIA 1 port A: the side select (bit 2) and the clock (bit 5). A pin
   *  the DOS has not made an output reads high. */
  private updateOutputs(): void {
    const via = this.via1;
    const pins = (via.ora & via.ddra) | (~via.ddra & 0xFF);
    this.fast = (pins & 0x20) !== 0;
    const side = (pins >> 2) & 1;
    if (side !== this.side) {
      this.side = side;
      this.seatTrack();
    }
  }

  private fdcRead(reg: number): number {
    switch (reg) {
      case 0: return this.fdc.readStatus();
      case 1: return this.fdc.readTrack();
      case 2: return this.fdc.readSectorReg();
      default: return this.fdc.readData();
    }
  }

  private fdcWrite(reg: number, value: number): void {
    switch (reg) {
      case 0: this.fdc.writeCommand(value); break;
      case 1: this.fdc.writeTrack(value); break;
      case 2: this.fdc.writeSectorReg(value); break;
      default: this.fdc.writeData(value); break;
    }
  }

  // ── Running ─────────────────────────────────────────────────────────────

  override runTo(target: number): void {
    if (!this.hasRom) return;
    const { cpu, via1, via2, cia } = this;
    while (cpu.tStates < target) {
      cpu.setIRQ(via1.irq || via2.irq || cia.irq);
      const before = cpu.tStates;
      cpu.step();
      const n = cpu.tStates - before;
      via1.addCycles(n);
      via2.addCycles(n);
      cia.advanceTo(cpu.tStates - this.stall);
      // At 1 MHz every cycle takes two ticks of the time base.
      if (!this.fast) { cpu.tStates += n; this.stall += n; }
      this.advanceQuarters(this.fast ? n * 2 : n * 4);
      this.fdcTicks += this.fast ? n : n * 2;
      if (this.fdcTicks >= FDC_TICK_CYCLES) {
        this.fdcTicks -= FDC_TICK_CYCLES;
        this.fdc.tickFrame();
      }
    }
  }

  // ── Debugger ────────────────────────────────────────────────────────────

  override describe(): string[] {
    const hx = (v: number, w = 2): string => v.toString(16).toUpperCase().padStart(w, '0');
    const c = this.cia;
    const f = this.fdc;
    return [
      `Clock ${this.fast ? '2' : '1'} MHz   side ${this.side}   track-0 sensor ${this.halfTrack === 0 ? 'on' : 'off'}   byte ${this.byteReady ? 'waiting' : 'read'}`,
      ...super.describe(),
      'CIA fast serial bus ($4000)',
      `  PRA ${hx(c.pra)} DDRA ${hx(c.ddra)}   PRB ${hx(c.prb)} DDRB ${hx(c.ddrb)}   TA ${hx(c.ta.counter, 4)} TB ${hx(c.tb.counter, 4)}   ICR flags ${hx(c.icrFlags)} mask ${hx(c.icrMask)}  ${c.irq ? 'IRQ asserted' : ''}`.trimEnd(),
      'WD1770 floppy controller ($2000, MFM; no MFM disk can be put in)',
      `  track ${hx(f.trackReg)}  sector ${hx(f.sectorReg)}`,
    ];
  }

  // ── Snapshot ────────────────────────────────────────────────────────────

  override saveState(w: StateSink): void {
    super.saveState(w);
    w.u8(this.side); w.bool(this.fast); w.bool(this.byteReady);
    w.f64(this.stall); w.u32(this.fdcTicks);
    this.cia.saveState(w);
    const sub = new StateWriter();
    this.fdc.saveState(sub);
    w.bytes(sub.finish());
  }

  override loadState(r: StateSource): void {
    super.loadState(r);
    this.side = r.u8() & 1; this.fast = r.bool(); this.byteReady = r.bool();
    this.stall = r.f64(); this.fdcTicks = r.u32();
    this.cia.loadState(r);
    this.fdc.loadState(new StateReader(r.bytes(1 << 20)));
    this.seatTrack();
  }
}
