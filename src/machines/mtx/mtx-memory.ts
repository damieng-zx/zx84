import type { IMachineMemory } from '@/machines/machine.ts';
import type { MtxModel } from './models.ts';

const BLOCK_SIZE = 0x4000;
const ROM_SIZE = 0x2000;
const ROM_PACK_MAX_SIZE = 0x20000;
const RAM_EXPANSION_BLOCKS = 512 * 1024 / BLOCK_SIZE;
const CPM_EMPTY_DIRECTORY_BYTE = 0xE5;

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
  private romPack: Uint8Array | null = null;
  private cpmBootstrapEnabled = false;
  private fdxRomEnabled = true;
  private ramExpansion512k = false;
  private readonly baseRamBlocks: number;

  constructor(readonly model: MtxModel) {
    this.baseRamBlocks = model === 'mtx500' ? 2 : model === 'mtx512' ? 4 : 8;
    this.ramBanks = Array.from(
      { length: this.baseRamBlocks },
      () => new Uint8Array(BLOCK_SIZE),
    );
  }

  get pageRegister(): number { return this.ioByte; }
  get selectedRomPage(): number { return (this.ioByte >> 4) & 7; }
  get selectedRomSubpage(): number { return this.romSubpage; }
  get selectedRamPage(): number { return this.ioByte & 0x0F; }
  get ramMode(): boolean { return (this.ioByte & 0x80) !== 0; }
  get ramExpansion512kEnabled(): boolean { return this.ramExpansion512k; }
  get ramSizeBytes(): number { return this.ramBanks.length * BLOCK_SIZE; }
  get romPackSizeBytes(): number { return this.romPack?.length ?? 0; }

  setCpmBootstrapEnabled(enabled: boolean): void {
    this.cpmBootstrapEnabled = enabled;
  }

  /** Empty the FDX Disk BASIC ROM socket (page 5) when the FDX floppy subsystem
   *  is not fitted — an absent board reads back as 0xFF. */
  setFdxRomEnabled(enabled: boolean): void {
    this.fdxRomEnabled = enabled;
  }

  set512kRamExpansionEnabled(enabled: boolean): void {
    if (this.ramExpansion512k === enabled) return;
    this.ramExpansion512k = enabled;
    const blocks = this.baseRamBlocks + (enabled ? RAM_EXPANSION_BLOCKS : 0);
    if (enabled) {
      while (this.ramBanks.length < blocks) {
        this.ramBanks.push(new Uint8Array(BLOCK_SIZE).fill(CPM_EMPTY_DIRECTORY_BYTE));
      }
    } else {
      this.ramBanks.length = blocks;
    }
  }

  setPageRegister(value: number): void {
    this.ioByte = value & 0xFF;
  }

  insertRomPack(data: Uint8Array): void {
    if (
      data.length < ROM_SIZE ||
      data.length > ROM_PACK_MAX_SIZE ||
      data.length % ROM_SIZE !== 0
    ) {
      throw new Error('ROM pack must contain 1-16 complete 8 KiB banks');
    }
    this.romPack = data.slice();
  }

  ejectRomPack(): void {
    this.romPack = null;
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
      if (this.selectedRomPage === 5 && !this.fdxRomEnabled) return 0xFF;
      if (this.selectedRomPage === 2 && this.romPack) {
        const offset = this.romSubpage * ROM_SIZE + addr - 0x2000;
        return offset < this.romPack.length ? this.romPack[offset] : 0xFF;
      }
      return this.romPages[this.selectedRomPage][addr - 0x2000];
    }
    const mapped = this.ramLocation(addr);
    return mapped ? mapped.bank[mapped.offset] : 0xFF;
  }

  writeByte(addr: number, value: number): void {
    addr &= 0xFFFF;
    value &= 0xFF;
    if (!this.ramMode && addr < 0x2000) {
      // The ROM extension card latches the written byte as its 8K subpage.
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

  get ramBankCount(): number { return this.ramBanks.length; }

  ramSnapshot(): Uint8Array {
    const out = new Uint8Array(this.ramBanks.length * BLOCK_SIZE);
    for (let i = 0; i < this.ramBanks.length; i++) out.set(this.ramBanks[i], i * BLOCK_SIZE);
    return out;
  }

  reset(): void {
    this.ioByte = 0;
    this.romSubpage = 0;
    // The motherboard RAM is working memory, while the 512 KiB expansion is
    // also used as CP/M's volatile RAM disc and survives the reset line.
    for (let i = 0; i < this.baseRamBlocks; i++) this.ramBanks[i].fill(0);
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
      // The MTX ROM's memory-sizing routine probes page 15. Real expanded
      // systems leave 0x4000-0x7FFF open there so it stops at 512 KiB rather
      // than counting the motherboard RAM a second time.
      if (page === 0x0F && region === 1) return null;
      block = region === 2 ? 1 + page * 2 : 2 + page * 2;
    }

    const bank = this.ramBanks[block];
    return bank ? { bank, offset: addr & 0x3FFF } : null;
  }
}
