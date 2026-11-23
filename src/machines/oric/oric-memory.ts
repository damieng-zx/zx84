/**
 * Oric memory map.
 *
 *   0x0000-0x00FF  zero page
 *   0x0100-0x01FF  stack
 *   0x0200-0x02FF  system variables (page 2)
 *   0x0300-0x03FF  I/O: the VIA, mirrored across the page, and any fitted card
 *   0x0400-0x97FF  user RAM
 *   0x9800-0x9FFF  character set window (the ULA reads $9800 or $9C00)
 *   0xA000-0xBF3F  hires screen (and the text screen inside it at $BB80)
 *   0xB400-0xBBFF  the same bytes, which the ULA reads as the text charset
 *   0xC000-0xFFFF  BASIC ROM — or, with ROMDIS, the 16 KB overlay RAM, and
 *                  with a Microdisc's EPROM selected, its 8 KB ROM at $E000
 *
 * This is one flat 64 KB RAM image, and the top 16 KB of it *is* the overlay
 * RAM: whether the CPU sees the overlay or the BASIC ROM there is a flag, so a
 * snapshot is one `raw()` of the array plus the two ROM chips.
 *
 * Page 3 is I/O, never RAM, whatever is mapped in above. Writes to ROM and to
 * the EPROM are dropped; writes to the overlay land in the top of `ram`.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import {
  ORIC_IO_BASE, ORIC_IO_END, ORIC_OVERLAY_BASE, ORIC_ROM_BASE, ORIC_ROM_SIZE,
} from './constants.ts';

const BANK_SIZE = 0x4000;

/** The Microdisc EPROM's window: the top 8 KB of the ROM area. */
export const ORIC_EPROM_BASE = 0xE000;
export const ORIC_EPROM_SIZE = 0x2000;

export class OricMemory implements IMachineMemory {
  /** The full address space. $0000-$BFFF is RAM, and the top 16 KB doubles as
   *  the overlay RAM that hides the BASIC ROM. */
  readonly ram = new Uint8Array(0x10000);
  /** The 16 KB BASIC/OS ROM. */
  readonly rom = new Uint8Array(ORIC_ROM_SIZE);
  /** The Microdisc's 8 KB boot EPROM (all zero when no card is fitted or its
   *  image has not been loaded). */
  readonly eprom = new Uint8Array(ORIC_EPROM_SIZE);

  /** ROMDIS is clear: the BASIC ROM is visible at $C000-$FFFF. */
  basicRomOn = true;
  /** With the overlay visible, the Microdisc EPROM takes $E000-$FFFF. */
  epromOn = false;

  /** Page-3 dispatch, wired by the machine: the VIA, then any card. */
  ioRead: (addr: number) => number = () => 0xFF;
  ioWrite: (addr: number, value: number) => void = () => {};
  /** Side-effect-free read for the debugger's Mapped view. */
  ioPeek: (addr: number) => number = () => 0xFF;

  /** True while the CPU sees the overlay RAM instead of the ROM. */
  get overlayOn(): boolean { return !this.basicRomOn; }

  /** ROMDIS: map the overlay RAM in (and hide the BASIC ROM). */
  setOverlay(on: boolean): void { this.basicRomOn = !on; }

  private inIo(addr: number): boolean {
    return addr >= ORIC_IO_BASE && addr < ORIC_IO_END;
  }

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (this.inIo(addr)) return this.ioRead(addr) & 0xFF;
    if (addr >= ORIC_ROM_BASE) {
      if (this.basicRomOn) return this.rom[addr - ORIC_ROM_BASE];
      if (this.epromOn && addr >= ORIC_EPROM_BASE) return this.eprom[addr - ORIC_EPROM_BASE];
    }
    return this.ram[addr];
  }

  peekByte(addr: number): number {
    addr &= 0xFFFF;
    if (this.inIo(addr)) return this.ioPeek(addr) & 0xFF;
    if (addr >= ORIC_ROM_BASE) {
      if (this.basicRomOn) return this.rom[addr - ORIC_ROM_BASE];
      if (this.epromOn && addr >= ORIC_EPROM_BASE) return this.eprom[addr - ORIC_EPROM_BASE];
    }
    return this.ram[addr];
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    val &= 0xFF;
    if (this.inIo(addr)) { this.ioWrite(addr, val); return; }
    if (addr >= ORIC_ROM_BASE) {
      // The BASIC ROM and the EPROM are read-only.
      if (this.basicRomOn) return;
      if (this.epromOn && addr >= ORIC_EPROM_BASE) return;
    }
    this.ram[addr] = val;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.peekByte((addr + i) & 0xFFFF);
    return out;
  }

  /** The address space as the CPU sees it, ROM windows included. */
  snapshot(): Uint8Array {
    const out = this.ram.slice();
    if (this.basicRomOn) out.set(this.rom, ORIC_ROM_BASE);
    else if (this.epromOn) out.set(this.eprom, ORIC_EPROM_BASE);
    return out;
  }

  /** Four 16 KB banks. */
  get ramBankCount(): number { return 0x10000 / BANK_SIZE; }

  getRamBank(n: number): Uint8Array {
    const bank = ((n % this.ramBankCount) + this.ramBankCount) % this.ramBankCount;
    return this.ram.subarray(bank * BANK_SIZE, (bank + 1) * BANK_SIZE);
  }

  /** The overlay RAM alone (the top 16 KB of the address space). */
  get overlay(): Uint8Array {
    return this.ram.subarray(ORIC_OVERLAY_BASE, ORIC_OVERLAY_BASE + ORIC_ROM_SIZE);
  }

  reset(): void {
    this.basicRomOn = true;
    this.epromOn = false;
  }

  /** Burn a system-ROM image. A 16 KB image is the whole ROM; anything else is
   *  refused (there is no banked set on these machines). */
  loadRom(data: Uint8Array): boolean {
    if (data.length !== ORIC_ROM_SIZE) return false;
    this.rom.set(data);
    return true;
  }

  /** Burn the Microdisc EPROM (8 KB). */
  loadEprom(data: Uint8Array): boolean {
    if (data.length !== ORIC_EPROM_SIZE) return false;
    this.eprom.set(data);
    return true;
  }
}
