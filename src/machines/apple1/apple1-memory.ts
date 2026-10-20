/**
 * Apple I memory map.
 *
 *   0x0000-0x0FFF  4K RAM; a second 4K at $1000-$1FFF when fitted, and further
 *                  4K pages up to $BFFF on an expansion board
 *   0xE000-0xEFFF  an optional 4K RAM card, where Apple BASIC loads
 *   0xD010-0xD013  the PIA's four registers, repeated through the $Dxxx page
 *                  (only the page and address bit 4 are decoded)
 *   0xFF00-0xFFFF  the Woz Monitor PROM, 256 bytes
 *
 * Everything else is unmapped and reads as $FF. The PIA is the only I/O: the
 * machine installs `ioRead`/`ioWrite` for it, and the debugger's `peekByte` and
 * `snapshot` reach the registers without the read side effects.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import { APPLE1_ROM_BASE, APPLE1_ROM_SIZE } from './constants.ts';

const PAGE_SHIFT = 12;
const PAGES = 16;
const BANK_SIZE = 0x4000;
/** The 4K page the BASIC RAM card occupies. */
const BASIC_PAGE = 0xE;

export class Apple1Memory implements IMachineMemory {
  /** Flat 64K backing store; only the pages marked in `ramPages` are live. */
  readonly ram = new Uint8Array(0x10000);
  /** The Monitor PROM at $FF00-$FFFF. */
  readonly rom = new Uint8Array(APPLE1_ROM_SIZE);
  /** Which 4K pages hold RAM. */
  private readonly ramPages = new Array<boolean>(PAGES).fill(false);

  /** PIA read/write hooks, given the register number (0-3). */
  ioRead: (reg: number) => number = () => 0xFF;
  ioWrite: (reg: number, val: number) => void = () => {};
  /** Side-effect-free register read for the debugger. */
  ioPeek: (reg: number) => number = () => 0xFF;

  constructor(ramKb = 8) {
    this.setRamKb(ramKb);
  }

  /** Fit `kb` of RAM contiguously from $0000, in 4K steps (at most 48K). */
  setRamKb(kb: number): void {
    const pages = Math.max(1, Math.min(12, Math.round(kb / 4)));
    for (let page = 0; page < BASIC_PAGE; page++) this.ramPages[page] = page < pages;
  }

  /** Kilobytes of RAM fitted from $0000. */
  get ramKb(): number {
    let pages = 0;
    while (pages < BASIC_PAGE && this.ramPages[pages]) pages++;
    return pages * 4;
  }

  /** Fit or remove the 4K RAM card at $E000-$EFFF. */
  setBasicRam(fitted: boolean): void {
    this.ramPages[BASIC_PAGE] = fitted;
  }

  get basicRam(): boolean { return this.ramPages[BASIC_PAGE]; }

  get ramBankCount(): number { return 0x10000 / BANK_SIZE; }

  getRamBank(n: number): Uint8Array {
    const bank = ((n % this.ramBankCount) + this.ramBankCount) % this.ramBankCount;
    return this.ram.subarray(bank * BANK_SIZE, (bank + 1) * BANK_SIZE);
  }

  private static isPia(addr: number): boolean { return (addr & 0xF010) === 0xD010; }

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr >= APPLE1_ROM_BASE) return this.rom[addr - APPLE1_ROM_BASE];
    if (Apple1Memory.isPia(addr)) return this.ioRead(addr & 3) & 0xFF;
    return this.ramPages[addr >> PAGE_SHIFT] ? this.ram[addr] : 0xFF;
  }

  peekByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr >= APPLE1_ROM_BASE) return this.rom[addr - APPLE1_ROM_BASE];
    if (Apple1Memory.isPia(addr)) return this.ioPeek(addr & 3) & 0xFF;
    return this.ramPages[addr >> PAGE_SHIFT] ? this.ram[addr] : 0xFF;
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    if (addr >= APPLE1_ROM_BASE) return;
    if (Apple1Memory.isPia(addr)) { this.ioWrite(addr & 3, val & 0xFF); return; }
    if (this.ramPages[addr >> PAGE_SHIFT]) this.ram[addr] = val & 0xFF;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.peekByte((addr + i) & 0xFFFF);
    return out;
  }

  snapshot(): Uint8Array {
    return this.readBlock(0, 0x10000);
  }

  /** Install the Monitor PROM. A larger image contributes its last page, which
   *  is the part that sits at $FF00. */
  loadRom(data: Uint8Array): void {
    this.rom.fill(0);
    this.rom.set(data.length > APPLE1_ROM_SIZE
      ? data.subarray(data.length - APPLE1_ROM_SIZE)
      : data);
  }

  /** A reset leaves RAM alone, as the real board does. */
  reset(): void {}
}
