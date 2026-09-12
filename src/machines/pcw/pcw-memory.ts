/**
 * PcwMemory — the PCW's paged memory.
 *
 * The Z80's 64K is four 16K "blocks", each mapped to any physical block of the
 * fitted 256K/512K by ports &F0-&F3. Like the CPC and the SAM — and unlike the
 * Spectrum — reads and writes can come from different places, so this keeps a
 * read pointer and a write pointer per block and swaps them O(1) on a paging
 * write rather than re-copying a flat 64K buffer.
 *
 *   readByte(addr)  = readPtr[addr >> 14][addr & 0x3FFF]
 *   writeByte(addr) = writePtr[addr >> 14][addr & 0x3FFF]
 *
 * There is no ROM anywhere in the machine: the PCW boots from disc, so every
 * mapping is RAM or open bus. See `bootstrap.ts`.
 *
 * Two documented details are easy to get backwards, and both are covered by
 * tests in `tests/pcw/memory.test.ts`:
 *
 *  - A &F0-&F3 write with **bit 7 set** puts one block under both reads and
 *    writes (`&87` = block 7, the usual value for &C000). With bit 7 **clear**
 *    the byte holds two different block numbers: writes in b0-2, reads in b4-6.
 *  - Port &F4's "reads follow writes" bits are **not** in address order. The
 *    reference lists b7-b4 as applying to &C000, &0000, &8000 and &4000
 *    respectively — see `MEMCTL_BIT_FOR_BLOCK`.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import type { PcwConfig } from './config.ts';
import {
  PCW_BANK_BLOCK_MASK, PCW_BANK_READ_SHIFT, PCW_BANK_SINGLE, PCW_BANK_WRITE_MASK,
  PCW_BLOCK_SIZE, PCW_RESET_BLOCKS, PCW_VIDEO_ADDRESS_MASK,
} from './constants.ts';

/**
 * Port &F4 bit that forces reads to follow writes, per Z80 block.
 *
 * Straight from the reference: "b7-b4: when set, force memory reads to access
 * the same bank as writes for &C000, &0000, &8000, and &4000 respectively".
 * Indexed by Z80 block (0 = &0000 … 3 = &C000), so block 0 → b6, block 1 → b4,
 * block 2 → b5, block 3 → b7.
 */
export const MEMCTL_BIT_FOR_BLOCK = [0x40, 0x10, 0x20, 0x80] as const;

/** What one Z80 block's reads resolve to, for the memory-layout pane. */
export interface PcwBlockSource {
  /** Physical block the CPU reads from, after the fitted-RAM wrap. */
  readonly read: number;
  /** Physical block the CPU's writes land in, after the fitted-RAM wrap. */
  readonly write: number;
}

/** Structured paging snapshot for the Banks pane and tests. */
export interface PcwPagingState {
  /** Raw &F0-&F3 register values. */
  readonly banks: readonly number[];
  /** Raw &F4 value. */
  readonly memctl: number;
  /** Resolved read/write block per Z80 block, low to high. */
  readonly blocks: readonly PcwBlockSource[];
}

export class PcwMemory implements IMachineMemory {
  private readonly cfg: PcwConfig;

  /** Physical 16K blocks (16 on a 256K machine, 32 on a 512K). */
  private readonly ram: Uint8Array[] = [];

  private readonly readPtr: Uint8Array[] = new Array(4);
  private readonly writePtr: Uint8Array[] = new Array(4);
  private readonly sources: PcwBlockSource[] = new Array(4);

  /** Raw &F0-&F3 values, as last written. */
  readonly banks = new Uint8Array(4);
  /** Raw &F4 value: which blocks have reads forced to follow writes. */
  memctl = 0;

  constructor(cfg: PcwConfig) {
    this.cfg = cfg;
    for (let i = 0; i < cfg.blocks; i++) this.ram.push(new Uint8Array(PCW_BLOCK_SIZE));
    this.reset();
  }

  // ── Paging ────────────────────────────────────────────────────────────────

  /** Write one of ports &F0-&F3. `index` is the Z80 block (0 = &0000). */
  setBank(index: number, value: number): void {
    this.banks[index & 3] = value & 0xFF;
    this.applyPaging();
  }

  /** Write port &F4: bits force reads to follow writes, per block. */
  setMemCtl(value: number): void {
    this.memctl = value & 0xFF;
    this.applyPaging();
  }

  /**
   * Map a block number onto the RAM actually fitted.
   *
   * A block number can address up to 2MB, far more than any PCW has. The
   * unfitted high bits are simply not wired, so a block past the end **aliases**
   * one that exists: on a 256K machine (16 blocks) block 20 is block 4.
   *
   * This is not a guess. CP/M Plus sizes memory by looking for that wrap, and
   * announces what it finds on the boot banner. Modelling absent blocks as open
   * bus instead — which is right on the SAM, whose ROM sizes memory by writing
   * and reading back — makes every candidate block look distinct, and CP/M
   * reports a 624K RAM disc on a 256K PCW and 1904K on a 512K one (i.e. the
   * whole 2MB block space). With the wrap it reports 112K and 368K, which is
   * what the real machines print.
   */
  private physical(n: number): number {
    return n & (this.cfg.blocks - 1);
  }

  private applyPaging(): void {
    for (let block = 0; block < 4; block++) {
      const value = this.banks[block];

      // Bit 7 set: one physical block for both reads and writes. Bit 7 clear:
      // two separate 3-bit block numbers, writes low, reads high.
      let readBlock: number;
      let writeBlock: number;
      if (value & PCW_BANK_SINGLE) {
        readBlock = writeBlock = value & PCW_BANK_BLOCK_MASK;
      } else {
        writeBlock = value & PCW_BANK_WRITE_MASK;
        readBlock = (value >>> PCW_BANK_READ_SHIFT) & PCW_BANK_WRITE_MASK;
      }

      // &F4 overrides the split, pointing reads back at the write block.
      if (this.memctl & MEMCTL_BIT_FOR_BLOCK[block]) readBlock = writeBlock;

      const readPhys = this.physical(readBlock);
      const writePhys = this.physical(writeBlock);
      this.readPtr[block] = this.ram[readPhys];
      this.writePtr[block] = this.ram[writePhys];
      this.sources[block] = { read: readPhys, write: writePhys };
    }
  }

  // ── Video fetch ───────────────────────────────────────────────────────────

  /**
   * Read one byte by *physical* address, for the gate array's display fetch and
   * its roller-RAM walk. The video circuitry addresses the first 128K directly
   * and never sees CPU paging, so this deliberately bypasses readPtr.
   */
  videoByte(physAddr: number): number {
    const addr = physAddr & PCW_VIDEO_ADDRESS_MASK;
    const block = this.physical(addr >>> 14);
    return this.ram[block][addr & 0x3FFF];
  }

  // ── IMachineMemory ────────────────────────────────────────────────────────

  readByte(addr: number): number {
    addr &= 0xFFFF;
    return this.readPtr[addr >>> 14][addr & 0x3FFF];
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    this.writePtr[addr >>> 14][addr & 0x3FFF] = val & 0xFF;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte((addr + i) & 0xFFFF);
    return out;
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    for (let b = 0; b < 4; b++) out.set(this.readPtr[b], b * PCW_BLOCK_SIZE);
    return out;
  }

  getRamBank(n: number): Uint8Array {
    return this.ram[n] ?? this.ram[0];
  }

  get ramBankCount(): number { return this.cfg.blocks; }

  /** How many physical 16K blocks are fitted. */
  get blockCount(): number { return this.cfg.blocks; }

  /** Every fitted block concatenated — the RAM export. */
  allRam(): Uint8Array {
    const out = new Uint8Array(this.cfg.blocks * PCW_BLOCK_SIZE);
    for (let i = 0; i < this.cfg.blocks; i++) out.set(this.ram[i], i * PCW_BLOCK_SIZE);
    return out;
  }

  reset(): void {
    // Reset paging is blocks 0-3 in order, each selected for read and write.
    for (let i = 0; i < 4; i++) this.banks[i] = PCW_RESET_BLOCKS[i];
    this.memctl = 0;
    // RAM contents survive a warm reset on real hardware, and the boot sector
    // re-initialises everything it depends on, so nothing is cleared here.
    this.applyPaging();
  }

  /** Zero every fitted block — a cold start, used when the machine is built. */
  clear(): void {
    for (const block of this.ram) block.fill(0);
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  pagingState(): PcwPagingState {
    return {
      banks: Array.from(this.banks),
      memctl: this.memctl,
      blocks: this.sources.slice(),
    };
  }
}
