import type { IMachineMemory } from '@/machines/machine.ts';
import type { MtxModel } from './models.ts';

const BLOCK_SIZE = 0x4000;
const ROM_SIZE = 0x2000;

/**
 * MTX banked memory.
 *
 * Port 0 is the IOBYTE: bits 0-3 select the RAM page, bits 4-6 select the
 * switchable 8K ROM at 0x2000, and bit 7 selects RAM-based (CP/M) mode.
 * Physical RAM is represented as 16K blocks, with block 0 always common at
 * 0xC000. Missing blocks read as 0xFF and discard writes.
 */
export class MtxMemory implements IMachineMemory {
  readonly osRom = new Uint8Array(ROM_SIZE).fill(0xFF);
  readonly romPages = Array.from({ length: 8 }, () => new Uint8Array(ROM_SIZE).fill(0xFF));
  readonly ramBanks: Uint8Array[];

  private ioByte = 0;
  private romSubpage = 0;
  private cpmBootstrapEnabled = false;

  constructor(readonly model: MtxModel) {
    const blocks = model === 'mtx500' ? 2 : 4;
    this.ramBanks = Array.from({ length: blocks }, () => new Uint8Array(BLOCK_SIZE));
  }

  get pageRegister(): number { return this.ioByte; }
  get selectedRomPage(): number { return (this.ioByte >> 4) & 7; }
  get selectedRomSubpage(): number { return this.romSubpage; }
  get selectedRamPage(): number { return this.ioByte & 0x0F; }
  get ramMode(): boolean { return (this.ioByte & 0x80) !== 0; }

  setCpmBootstrapEnabled(enabled: boolean): void {
    this.cpmBootstrapEnabled = enabled;
  }

  setPageRegister(value: number): void {
    this.ioByte = value & 0xFF;
  }

  /**
   * Install firmware in physical order: 8K OS, 8K BASIC (page 0), 8K ASSEM
   * (page 1), 8K CP/M bootstrap (page 4), and 8K FDX/SDX Disk BASIC (page 5).
   *
   * Older 32K combined images pre-date the bootstrap slot and place Disk BASIC
   * fourth. Keep accepting that layout so existing custom ROM packs still boot.
   */
  loadRom(data: Uint8Array): void {
    this.osRom.fill(0xFF);
    for (const page of this.romPages) page.fill(0xFF);
    this.osRom.set(data.subarray(0, ROM_SIZE));
    this.romPages[0].set(data.subarray(ROM_SIZE, ROM_SIZE * 2));
    this.romPages[1].set(data.subarray(ROM_SIZE * 2, ROM_SIZE * 3));
    if (data.length >= ROM_SIZE * 5) {
      this.romPages[4].set(data.subarray(ROM_SIZE * 3, ROM_SIZE * 4));
      this.romPages[5].set(data.subarray(ROM_SIZE * 4, ROM_SIZE * 5));
    } else {
      this.romPages[5].set(data.subarray(ROM_SIZE * 3, ROM_SIZE * 4));
    }
  }

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (!this.ramMode && addr < 0x2000) return this.osRom[addr];
    if (!this.ramMode && addr < 0x4000) {
      if (this.selectedRomPage === 4 && !this.cpmBootstrapEnabled) return 0xFF;
      return this.romPages[this.selectedRomPage][addr - 0x2000];
    }
    const mapped = this.ramLocation(addr);
    return mapped ? mapped.bank[mapped.offset] : 0xFF;
  }

  writeByte(addr: number, value: number): void {
    addr &= 0xFFFF;
    value &= 0xFF;
    if (!this.ramMode && addr < 0x2000) {
      // Writes under the fixed OS ROM select a subpage on expansion ROM
      // hardware. Standard MTX ROMs have one subpage, but retain the latch.
      this.romSubpage = value;
      return;
    }
    if (!this.ramMode && addr < 0x4000) return;
    const mapped = this.ramLocation(addr);
    if (mapped) mapped.bank[mapped.offset] = value;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte(addr + i);
    return out;
  }

  snapshot(): Uint8Array {
    return this.readBlock(0, 0x10000);
  }

  getRamBank(n: number): Uint8Array {
    if (n < 0 || n >= this.ramBanks.length) return new Uint8Array(BLOCK_SIZE);
    return this.ramBanks[n];
  }

  ramSnapshot(): Uint8Array {
    const out = new Uint8Array(this.ramBanks.length * BLOCK_SIZE);
    for (let i = 0; i < this.ramBanks.length; i++) out.set(this.ramBanks[i], i * BLOCK_SIZE);
    return out;
  }

  reset(): void {
    this.ioByte = 0;
    this.romSubpage = 0;
    for (const bank of this.ramBanks) bank.fill(0);
  }

  private ramLocation(addr: number): { bank: Uint8Array; offset: number } | null {
    if (addr >= 0xC000) {
      return { bank: this.ramBanks[0], offset: addr - 0xC000 };
    }

    const region = addr >> 14; // 0:0000, 1:4000, 2:8000
    let block: number;
    if (this.ramMode) {
      const page = this.selectedRamPage;
      // Page zero is wired in reverse order so its conventional ROM-mode
      // banks remain at 0x8000, 0x4000, then 0x0000 when ROMs are removed.
      block = page === 0 ? 3 - region : 1 + page * 3 + region;
    } else {
      const page = this.selectedRamPage;
      block = region === 2 ? 1 + page * 2 : 2 + page * 2;
    }

    const bank = this.ramBanks[block];
    return bank ? { bank, offset: addr & 0x3FFF } : null;
  }
}
