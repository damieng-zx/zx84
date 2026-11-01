/**
 * Commodore VIC-20 memory: the CPU's 64K map, the VIC's 14-bit view of it,
 * and the colour RAM.
 *
 *   $0000-$03FF  1K RAM (on the board)
 *   $0400-$0FFF  RAM1-3: 3K expansion
 *   $1000-$1FFF  4K RAM (on the board)
 *   $2000-$7FFF  BLK1-3: 8K expansion blocks
 *   $8000-$8FFF  character ROM
 *   $9000-$93FF  I/O 0: the VIC ($9000, every 16 bytes to $90FF), and the VIAs
 *                ($9100-$93FF: A4 selects VIA 1, A5 VIA 2, both at once when
 *                both are set)
 *   $9400-$97FF  colour RAM, 1K × 4 bits
 *   $9800-$9FFF  I/O 2 and I/O 3, for the expansion port
 *   $A000-$BFFF  BLK5: the cartridge
 *   $C000-$DFFF  BASIC ROM
 *   $E000-$FFFF  KERNAL ROM
 *
 * Nothing answers a read of a place with nothing in it, so the CPU reads what
 * the VIC last left on the data bus (the machine supplies it as `openBus`).
 * The colour RAM is four bits wide and its top four bits read the same way.
 *
 * The VIC addresses 16K: its A13 is the CPU's A15 inverted, so VIC $0000-$1FFF
 * is CPU $8000-$9FFF (the character ROM) and VIC $2000-$3FFF is CPU
 * $0000-$1FFF. Only the RAM on the board is on the VIC's bus: expansion RAM
 * cannot hold the screen or the characters. The colour RAM reaches the VIC on
 * a bus of its own, addressed by the low ten bits of the screen address.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { VIC20_BASIC_SIZE, VIC20_CHARGEN_SIZE, VIC20_KERNAL_SIZE } from './constants.ts';

/** Expansion RAM fitted on the cartridge port. */
export interface Vic20RamExpansion {
  /** RAM1-3: 3K at $0400-$0FFF. */
  readonly ram123: boolean;
  /** BLK1, BLK2, BLK3: 8K each at $2000, $4000, $6000. */
  readonly blk1: boolean;
  readonly blk2: boolean;
  readonly blk3: boolean;
  /** BLK5: 8K at $A000, where a cartridge usually goes. */
  readonly blk5: boolean;
}

export const VIC20_NO_EXPANSION: Vic20RamExpansion = {
  ram123: false, blk1: false, blk2: false, blk3: false, blk5: false,
};

export type IoRead = (addr: number) => number;
export type IoWrite = (addr: number, value: number) => void;

export class Vic20Memory implements IMachineMemory {
  /** The whole 64K, so RAM sits at its own address; only fitted parts are used. */
  readonly ram = new Uint8Array(0x10000);
  readonly basic = new Uint8Array(VIC20_BASIC_SIZE);
  readonly kernal = new Uint8Array(VIC20_KERNAL_SIZE);
  readonly chargen = new Uint8Array(VIC20_CHARGEN_SIZE);
  /** Colour RAM: the low nybble of each byte is the stored colour. */
  readonly colorRam = new Uint8Array(0x400);

  /** What is fitted on the expansion port. */
  expansion: Vic20RamExpansion = VIC20_NO_EXPANSION;
  /** RAM present per 1K page (64 pages), from the board and the expansion. */
  private readonly ramPage = new Uint8Array(64);

  /** The VIC (`$9000-$93FF` with A8 and A9 low) and the VIAs. */
  ioRead: IoRead = () => 0xFF;
  ioWrite: IoWrite = () => {};
  /** I/O as the debugger sees it: no clear-on-read side effects. */
  ioPeek: IoRead = () => 0xFF;
  /** What a read of an empty place finds: the VIC's last byte on the bus. */
  openBus: () => number = () => 0xFF;

  constructor() {
    this.setExpansion(VIC20_NO_EXPANSION);
    this.reset();
  }

  /** Power-on: RAM in a pattern of stripes, as DRAM and SRAM settle. */
  reset(): void {
    for (let i = 0; i < 0x10000; i++) this.ram[i] = (i & 0x40) === 0 ? 0x00 : 0xFF;
    for (let i = 0; i < 0x400; i++) this.colorRam[i] = (i * 7 + 3) & 0x0F;
  }

  /** Fit expansion RAM (a power cycle on the real machine). */
  setExpansion(exp: Vic20RamExpansion): void {
    this.expansion = exp;
    const p = this.ramPage;
    p.fill(0);
    p[0] = 1;                                   // $0000-$03FF
    for (let i = 4; i < 8; i++) p[i] = 1;       // $1000-$1FFF
    if (exp.ram123) for (let i = 1; i < 4; i++) p[i] = 1;
    const block = (on: boolean, first: number): void => {
      if (on) for (let i = first; i < first + 8; i++) p[i] = 1;
    };
    block(exp.blk1, 8);
    block(exp.blk2, 16);
    block(exp.blk3, 24);
    block(exp.blk5, 40);
  }

  /** Whether RAM answers at `addr`. */
  isRam(addr: number): boolean { return this.ramPage[(addr >> 10) & 63] === 1; }

  loadRoms(basic: Uint8Array | null, kernal: Uint8Array | null, chargen: Uint8Array | null): void {
    if (basic) this.basic.set(basic.subarray(0, VIC20_BASIC_SIZE));
    if (kernal) this.kernal.set(kernal.subarray(0, VIC20_KERNAL_SIZE));
    if (chargen) this.chargen.set(chargen.subarray(0, VIC20_CHARGEN_SIZE));
  }

  // ── CPU bus ──────────────────────────────────────────────────────────────

  readByte(addr: number): number {
    addr &= 0xFFFF;
    switch (addr >> 12) {
      case 0x8: return this.chargen[addr & 0x0FFF];
      case 0x9:
        if (addr < 0x9400) return this.ioRead(addr);
        if (addr < 0x9800) return (this.openBus() & 0xF0) | (this.colorRam[addr & 0x3FF] & 0x0F);
        return this.openBus();
      case 0xC: case 0xD: return this.basic[addr - 0xC000];
      case 0xE: case 0xF: return this.kernal[addr - 0xE000];
      default:
        return this.ramPage[addr >> 10] === 1 ? this.ram[addr] : this.openBus();
    }
  }

  writeByte(addr: number, value: number): void {
    addr &= 0xFFFF;
    const v = value & 0xFF;
    if ((addr >> 12) === 0x9) {
      if (addr < 0x9400) this.ioWrite(addr, v);
      else if (addr < 0x9800) this.colorRam[addr & 0x3FF] = v & 0x0F;
      return;
    }
    if (this.ramPage[addr >> 10] === 1) this.ram[addr] = v;
  }

  /** What the CPU would read, without I/O side effects (for the debugger).
   *  Empty places read as `$FF` here rather than the VIC's bus. */
  peekByte(addr: number): number {
    addr &= 0xFFFF;
    switch (addr >> 12) {
      case 0x8: return this.chargen[addr & 0x0FFF];
      case 0x9:
        if (addr < 0x9400) return this.ioPeek(addr) & 0xFF;
        if (addr < 0x9800) return 0xF0 | (this.colorRam[addr & 0x3FF] & 0x0F);
        return 0xFF;
      case 0xC: case 0xD: return this.basic[addr - 0xC000];
      case 0xE: case 0xF: return this.kernal[addr - 0xE000];
      default:
        return this.ramPage[addr >> 10] === 1 ? this.ram[addr] : 0xFF;
    }
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.peekByte((addr + i) & 0xFFFF);
    return out;
  }

  /** A whole 64K view as the CPU sees it (I/O registers peeked). */
  snapshot(): Uint8Array { return this.readBlock(0, 0x10000); }

  get ramBankCount(): number { return 4; }

  /** One 16K quarter of the address space's RAM array, live. */
  getRamBank(n: number): Uint8Array {
    const bank = ((n % 4) + 4) % 4;
    return this.ram.subarray(bank << 14, (bank + 1) << 14);
  }

  // ── VIC bus ──────────────────────────────────────────────────────────────

  /**
   * A byte of the VIC's 16K view: the character ROM at VIC $0000-$0FFF, the
   * board's RAM at VIC $2000-$23FF and $3000-$3FFF. The I/O block and the
   * places the expansion RAM would be are not on the VIC's bus; they read as
   * $FF.
   */
  vicRead(addr14: number): number {
    const a = addr14 & 0x3FFF;
    if (a < 0x1000) return this.chargen[a];
    if (a < 0x2000) return 0xFF;
    const cpu = a & 0x1FFF;
    return cpu < 0x0400 || cpu >= 0x1000 ? this.ram[cpu] : 0xFF;
  }

  /** The colour nybble the VIC reads beside the screen byte at VIC `addr14`. */
  vicColour(addr14: number): number { return this.colorRam[addr14 & 0x3FF] & 0x0F; }

  saveState(w: StateWriter): void {
    w.raw(this.ram);
    w.raw(this.colorRam);
  }

  loadState(r: StateReader): void {
    r.rawInto(this.ram);
    r.rawInto(this.colorRam);
  }
}
