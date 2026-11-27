/**
 * Acorn Atom memory map.
 *
 *   0x0000-0x03FF  1 KB CPU workspace (zero page, stack, BASIC variables)
 *   0x0400-0x27FF  unfitted on a standard 12 KB Atom (open bus)
 *   0x2800-0x3BFF  5 KB lower text RAM (12 KB expansion)
 *   0x3C00-0x7FFF  unfitted (open bus)
 *   0x8000-0x97FF  6847 display RAM: 1 KB standard, 6 KB expanded
 *   0x9800-0x9FFF  unfitted (open bus)
 *   0xA000-0xAFFF  optional utility ROM socket (open bus when empty)
 *   0xB000-0xB3FF  8255 PPI, mirrored through the 1 KB block
 *   0xB400-0xB7FF  Econet/expansion (open bus)
 *   0xB800-0xBBFF  6522 VIA, mirrored through the 1 KB block
 *   0xBC00-0xBFFF  open bus
 *   0xC000-0xCFFF  BASIC ROM
 *   0xD000-0xDFFF  floating point ROM
 *   0xE000-0xEFFF  DOS ROM socket (open bus when empty)
 *   0xF000-0xFFFF  kernel/COS ROM
 *
 * A 2 KB Atom has only the first 1 KB and the first 1 KB of display RAM; its
 * upper text space is the top half of that 1 KB. The 12 KB machine adds the 5 KB
 * at $2800 and the remaining 5 KB of display RAM. Writes to ROM and unfitted
 * space are ignored; reads return $FF, as the open bus does.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import {
  ATOM_BASIC_BASE, ATOM_FLOAT_BASE, ATOM_KERNEL_BASE, ATOM_ROM_CHIP_SIZE,
  ATOM_VRAM_BASE, ATOM_VRAM_SIZE,
} from './constants.ts';

const BANK_SIZE = 0x4000;
const RAM_BASE_SIZE = 0x0400;
const TEXT_RAM_BASE = 0x2800;
const TEXT_RAM_SIZE = 0x1400;
const VIDEO_RAM_BASE = 0x8000;
const PPI_BASE = 0xB000;
const PPI_END = 0xB400;
const VIA_BASE = 0xB800;
const VIA_END = 0xBC00;

export class AtomMemory implements IMachineMemory {
  /** Flat address-space backing; only the fitted RAM regions are live. */
  readonly ram = new Uint8Array(0x10000);
  /** The three system-ROM chips. */
  readonly basicRom = new Uint8Array(ATOM_ROM_CHIP_SIZE);
  readonly floatRom = new Uint8Array(ATOM_ROM_CHIP_SIZE);
  readonly kernelRom = new Uint8Array(ATOM_ROM_CHIP_SIZE);

  /** The 5 KB lower text RAM is fitted (12 KB machine). */
  textRam = true;
  /** KB of display RAM fitted: 1 or 6. */
  videoKb: 1 | 6 = 6;

  /** PPI/VIA access hooks. The machine wires the chips; the debugger's
   *  `peekByte` uses the side-effect-free variants. */
  ppiRead: (reg: number) => number = () => 0xFF;
  ppiWrite: (reg: number, value: number) => void = () => {};
  ppiPeek: (reg: number) => number = () => 0xFF;
  viaRead: (reg: number) => number = () => 0xFF;
  viaWrite: (reg: number, value: number) => void = () => {};
  viaPeek: (reg: number) => number = () => 0xFF;

  constructor(ramKb: 2 | 12 = 12) {
    this.setRamKb(ramKb);
  }

  /** Fit 2 KB (1 KB workspace + 1 KB video) or 12 KB (adds 5 KB text and the
   *  remaining display RAM). RAM contents are left alone where the region
   *  stays fitted. */
  setRamKb(ramKb: number): void {
    const expanded = ramKb >= 12;
    const wasExpanded = this.textRam && this.videoKb === 6;
    this.textRam = expanded;
    this.videoKb = expanded ? 6 : 1;
    if (!expanded && wasExpanded) {
      // The unfitted halves read as open bus; don't show stale display data.
      this.ram.fill(0xFF, TEXT_RAM_BASE, TEXT_RAM_BASE + TEXT_RAM_SIZE);
      this.ram.fill(0xFF, VIDEO_RAM_BASE + 0x0400, VIDEO_RAM_BASE + ATOM_VRAM_SIZE);
    }
  }

  get ramKb(): number {
    return 1 + (this.textRam ? 5 : 0) + this.videoKb;
  }

  /** The 6847's view of display RAM (always the full 6 KB window; the chip
   *  wraps within it and unfitted bytes read as the idle fill). */
  get vram(): Uint8Array {
    return this.ram.subarray(ATOM_VRAM_BASE, ATOM_VRAM_BASE + ATOM_VRAM_SIZE);
  }

  /** The 512-byte text screen at $8000-$81FF. */
  get textScreen(): Uint8Array {
    return this.ram.subarray(ATOM_VRAM_BASE, ATOM_VRAM_BASE + 0x0200);
  }

  private fitted(addr: number): boolean {
    if (addr < RAM_BASE_SIZE) return true;
    if (this.textRam && addr >= TEXT_RAM_BASE && addr < TEXT_RAM_BASE + TEXT_RAM_SIZE) return true;
    if (addr >= VIDEO_RAM_BASE && addr < VIDEO_RAM_BASE + this.videoKb * 0x0400) return true;
    return false;
  }

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr >= ATOM_BASIC_BASE && addr < ATOM_BASIC_BASE + ATOM_ROM_CHIP_SIZE) {
      return this.basicRom[addr - ATOM_BASIC_BASE];
    }
    if (addr >= ATOM_FLOAT_BASE && addr < ATOM_FLOAT_BASE + ATOM_ROM_CHIP_SIZE) {
      return this.floatRom[addr - ATOM_FLOAT_BASE];
    }
    if (addr >= ATOM_KERNEL_BASE) return this.kernelRom[addr - ATOM_KERNEL_BASE];
    if (addr >= PPI_BASE && addr < PPI_END) return this.ppiRead(addr & 3) & 0xFF;
    if (addr >= VIA_BASE && addr < VIA_END) return this.viaRead(addr & 0x0F) & 0xFF;
    return this.fitted(addr) ? this.ram[addr] : 0xFF;
  }

  peekByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr >= ATOM_BASIC_BASE && addr < ATOM_BASIC_BASE + ATOM_ROM_CHIP_SIZE) {
      return this.basicRom[addr - ATOM_BASIC_BASE];
    }
    if (addr >= ATOM_FLOAT_BASE && addr < ATOM_FLOAT_BASE + ATOM_ROM_CHIP_SIZE) {
      return this.floatRom[addr - ATOM_FLOAT_BASE];
    }
    if (addr >= ATOM_KERNEL_BASE) return this.kernelRom[addr - ATOM_KERNEL_BASE];
    if (addr >= PPI_BASE && addr < PPI_END) return this.ppiPeek(addr & 3) & 0xFF;
    if (addr >= VIA_BASE && addr < VIA_END) return this.viaPeek(addr & 0x0F) & 0xFF;
    return this.fitted(addr) ? this.ram[addr] : 0xFF;
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    if (addr >= ATOM_BASIC_BASE && addr < ATOM_BASIC_BASE + ATOM_ROM_CHIP_SIZE) return;
    if (addr >= ATOM_FLOAT_BASE && addr < ATOM_FLOAT_BASE + ATOM_ROM_CHIP_SIZE) return;
    if (addr >= ATOM_KERNEL_BASE) return;
    if (addr >= PPI_BASE && addr < PPI_END) { this.ppiWrite(addr & 3, val & 0xFF); return; }
    if (addr >= VIA_BASE && addr < VIA_END) { this.viaWrite(addr & 0x0F, val & 0xFF); return; }
    if (this.fitted(addr)) this.ram[addr] = val & 0xFF;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.peekByte((addr + i) & 0xFFFF);
    return out;
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000).fill(0xFF);
    out.set(this.ram.subarray(0, RAM_BASE_SIZE), 0);
    if (this.textRam) {
      out.set(this.ram.subarray(TEXT_RAM_BASE, TEXT_RAM_BASE + TEXT_RAM_SIZE), TEXT_RAM_BASE);
    }
    out.set(this.ram.subarray(VIDEO_RAM_BASE, VIDEO_RAM_BASE + this.videoKb * 0x0400), VIDEO_RAM_BASE);
    out.set(this.basicRom, ATOM_BASIC_BASE);
    out.set(this.floatRom, ATOM_FLOAT_BASE);
    out.set(this.kernelRom, ATOM_KERNEL_BASE);
    return out;
  }

  get ramBankCount(): number { return 0x10000 / BANK_SIZE; }

  getRamBank(n: number): Uint8Array {
    const bank = ((n % this.ramBankCount) + this.ramBankCount) % this.ramBankCount;
    return this.ram.subarray(bank * BANK_SIZE, (bank + 1) * BANK_SIZE);
  }

  reset(): void {}

  /**
   * Burn a system-ROM image. The standard set is the three 4 KB chips
   * concatenated in `romSources` order (BASIC, floating point, kernel). A
   * 16 KB image in the MAME layout (BASIC + FP at the bottom, kernel at
   * +$3000) is accepted too, as is a bare 4 KB kernel. Returns false for a
   * size that is not one of those.
   */
  loadRom(data: Uint8Array): boolean {
    const chip = ATOM_ROM_CHIP_SIZE;
    if (data.length >= ATOM_ROM_CHIP_SIZE * 3 && data.length < 0x4000) {
      this.basicRom.set(data.subarray(0, chip));
      this.floatRom.set(data.subarray(chip, chip * 2));
      this.kernelRom.set(data.subarray(chip * 2, chip * 3));
      return true;
    }
    if (data.length === 0x4000) {
      this.basicRom.set(data.subarray(0, chip));
      this.floatRom.set(data.subarray(chip, chip * 2));
      this.kernelRom.set(data.subarray(0x3000, 0x4000));
      return true;
    }
    if (data.length === chip) {
      this.kernelRom.set(data);
      return true;
    }
    return false;
  }
}
