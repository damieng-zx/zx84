/**
 * Acorn Electron memory map.
 *
 *   0x0000-0x7FFF  32K RAM (4× 4164 DRAM, shared with the ULA's display fetch)
 *   0x8000-0xBFFF  one of sixteen 16K ROM windows, picked by the ULA's page
 *                  register: 8/9 read the keyboard, 10/11 are BASIC, 12-15 are
 *                  the expansion (Plus 1) slots, 0-7 the sideways sockets
 *   0xC000-0xFBFF  OS ROM
 *   0xFC00-0xFEFF  FRED / JIM (1 MHz bus) and the ULA ("sheila")
 *   0xFF00-0xFFFF  OS ROM
 *
 * The machine installs `ioRead`/`ioWrite` for the hardware window and `kbdRead`
 * for the keyboard pages.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import {
  ELECTRON_BASIC_PAGE, ELECTRON_KEYBOARD_PAGE, ELECTRON_ROM_PAGES, ELECTRON_ROM_SIZE,
} from './models.ts';

const RAM_SIZE = 0x8000;

export class ElectronMemory implements IMachineMemory {
  /** 0x0000-0x7FFF, split into two 16K banks for the debug memory pane. */
  readonly ram = new Uint8Array(RAM_SIZE);
  /** The 16K language ROM (BASIC), visible in pages 10 and 11. */
  readonly basicRom = new Uint8Array(ELECTRON_ROM_SIZE);
  /** The 16K OS ROM at 0xC000. */
  readonly osRom = new Uint8Array(ELECTRON_ROM_SIZE);
  /** Sideways ROM images by page; pages without one read 0xFF. */
  readonly roms: (Uint8Array | null)[] = Array.from({ length: ELECTRON_ROM_PAGES }, () => null);
  /** ROMs on fitted expansions (the Plus 1's OS and cartridges, the Plus 3's
   *  ADFS). They sit on the bus alongside the sideways sockets and win over
   *  them in the same page. */
  readonly expansion: (Uint8Array | null)[] = Array.from({ length: ELECTRON_ROM_PAGES }, () => null);

  /** The ULA's ROM page register (low nibble of 0xFE05). */
  romPage = 0;

  /** Hardware window read hook (0xFC00-0xFEFF). */
  ioRead: (addr: number) => number = () => 0xFF;
  /** Hardware window write hook. */
  ioWrite: (addr: number, val: number) => void = () => {};
  /** Keyboard read: the pressed bits of every column whose address line is low. */
  kbdRead: (addr: number) => number = () => 0;

  get ramBankCount(): number { return 2; }

  getRamBank(n: number): Uint8Array {
    const bank = n & 1;
    return this.ram.subarray(bank * 0x4000, (bank + 1) * 0x4000);
  }

  /** The byte the paged window shows at `addr` (0x8000-0xBFFF). */
  private pagedRead(addr: number): number {
    const page = this.romPage;
    if (page === ELECTRON_KEYBOARD_PAGE || page === ELECTRON_KEYBOARD_PAGE + 1) {
      return this.kbdRead(addr) & 0x0F;
    }
    if (page === ELECTRON_BASIC_PAGE || page === ELECTRON_BASIC_PAGE + 1) {
      return this.basicRom[addr & 0x3FFF];
    }
    const rom = this.expansion[page] ?? this.roms[page];
    return rom ? rom[addr & 0x3FFF] : 0xFF;
  }

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr < 0x8000) return this.ram[addr];
    if (addr < 0xC000) return this.pagedRead(addr);
    if (addr >= 0xFC00 && addr < 0xFF00) return this.ioRead(addr) & 0xFF;
    return this.osRom[addr & 0x3FFF];
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    if (addr < 0x8000) { this.ram[addr] = val & 0xFF; return; }
    if (addr >= 0xFC00 && addr < 0xFF00) this.ioWrite(addr, val & 0xFF);
    // Everywhere else is ROM: writes are ignored.
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte((addr + i) & 0xFFFF);
    return out;
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    out.set(this.ram, 0x0000);
    for (let a = 0x8000; a < 0xC000; a++) out[a] = this.pagedRead(a);
    out.set(this.osRom, 0xC000);
    return out;
  }

  /** The ULA's page register write. The hardware only lets software leave the
   *  BASIC/keyboard pair (8-11) for the upper half (8-15): a write that does
   *  not set bit 3 is ignored while one of pages 8-11 is selected. */
  writePage(value: number): void {
    if ((this.romPage & 0x0C) === 0x08 && (value & 0x08) === 0) return;
    this.romPage = value & 0x0F;
  }

  /** Load a 32K system image: BASIC (16K) followed by the OS (16K), the layout of
   *  the Electron's single mask ROM. */
  loadRom(data: Uint8Array): void {
    if (data.length >= ELECTRON_ROM_SIZE) this.basicRom.set(data.subarray(0, ELECTRON_ROM_SIZE));
    if (data.length >= ELECTRON_ROM_SIZE * 2) {
      this.osRom.set(data.subarray(ELECTRON_ROM_SIZE, ELECTRON_ROM_SIZE * 2));
    }
  }

  /** A 16K window image of `data`: a ROM smaller than the window (4K, 8K) has
   *  its upper address lines unconnected, so it repeats to fill it. */
  static windowImage(data: Uint8Array): Uint8Array {
    const dst = new Uint8Array(ELECTRON_ROM_SIZE);
    if (data.length === 0) return dst;
    const size = Math.min(data.length, ELECTRON_ROM_SIZE);
    for (let at = 0; at < ELECTRON_ROM_SIZE; at += size) dst.set(data.subarray(0, size), at);
    return dst;
  }

  /** Install a ROM image in a sideways page. */
  loadPagedRom(page: number, data: Uint8Array): void {
    this.roms[page & 0x0F] = ElectronMemory.windowImage(data);
  }

  clearPagedRom(page: number): void { this.roms[page & 0x0F] = null; }

  /** Put an expansion's ROM (or null to remove it) in a page. */
  setExpansionRom(page: number, data: Uint8Array | null): void {
    this.expansion[page & 0x0F] = data ? ElectronMemory.windowImage(data) : null;
  }

  reset(): void {
    this.romPage = 0;
  }
}
