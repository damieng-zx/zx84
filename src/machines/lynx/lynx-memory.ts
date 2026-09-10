/**
 * LynxMemory — the Camputers Lynx's banked 64K window.
 *
 * The machine is unusual in two ways, both from MAME's `camplynx.cpp`:
 *
 *  - A write goes to *every* enabled bank at once. The bank port's write
 *    nibble enables banks 1-4, and on the 48K/96K two bits of port 0x80 veto
 *    the two video banks, so the ROM can paint one byte into red and blue in a
 *    single store.
 *  - A read comes from whichever bank the decode selects. The read nibble
 *    picks one of a handful of fixed 8-page layouts rather than composing a
 *    slot at a time.
 *
 * Storage is one flat array of 8K pages, exactly as MAME lays it out, because
 * the bank tables are written in those terms:
 *
 *   pages  0-7   bank 0 — the ROM images at their load addresses, 0xFF elsewhere
 *   pages  8-15  bank 1 — user RAM
 *   pages 16-23  bank 2 — 48K/96K: spare; 128K: video (red 16, blue 18, greens 20/22)
 *   pages 24-31  bank 3 — 48K/96K: video (blue 20, red 22, greens 28/30)
 *   pages 32-39  bank 4 — the 128K's extra RAM
 *
 * The 48K's video planes are not where the bank numbering suggests: MAME reads
 * them at flat offsets 0x28000/0x2C000/0x38000/0x3C000, which fall inside banks
 * 2 and 3, and its writes mirror each store to four addresses so both halves of
 * each bank hold the same image. That mirroring is real decode, not a
 * shortcut — see `writeByte`.
 */

import { LYNX_PAGE_SIZE, LYNX_PAGES } from './constants.ts';
import type { LynxModel } from './models.ts';

/** Pages in the flat array. 32 for the 48K/96K, 40 for the 128K. */
const PAGES_48 = 32;
const PAGES_128 = 40;

/** Where each ROM image is loaded inside bank 0, from MAME's ROM_LOAD offsets. */
export const ROM_LOAD_OFFSETS = [0x0000, 0x2000, 0x4000] as const;
/** The disk interface's ROM sits high in bank 0, paged in over slot 7. */
export const DOS_ROM_OFFSET = 0xe000;

/** One read layout: the page occupying each of the eight 8K slots. */
type Layout = readonly number[];

function layouts(
  table: ReadonlyArray<readonly [readonly number[], Layout]>,
): Record<number, Layout> {
  const out: Record<number, Layout> = {};
  for (const [keys, pages] of table) for (const key of keys) out[key] = pages;
  return out;
}

/**
 * 48K/96K read layouts, keyed by the `rbyte` MAME's `port7f_w` computes from
 * the bank port's read nibble and port 0x80's bits 2-3. Every alias in the
 * source's case fall-through is listed, so an unlisted value really is one the
 * hardware cannot produce.
 */
const LAYOUTS_48: Readonly<Record<number, Layout>> = layouts([
  // ROM low and mirrored high — the layout the machine resets into.
  [[0x00, 0x04, 0x08, 0x0c, 0x10, 0x14, 0x18, 0x1c], [0, 1, 2, 3, 0, 1, 2, 7]],
  [[0x20, 0x24, 0x28, 0x2c], [8, 9, 10, 11, 12, 13, 14, 7]],
  [[0x30, 0x34, 0x38, 0x3c], [0, 1, 2, 11, 12, 13, 14, 7]],
  [[0x44, 0x64], [24, 25, 26, 27, 28, 29, 30, 31]],
  [[0x40, 0x60, 0x48, 0x68, 0x4c, 0x6c], [16, 17, 18, 19, 20, 21, 22, 23]],
  [[0x54, 0x74], [0, 1, 2, 27, 28, 29, 30, 31]],
  [[0x50, 0x70, 0x58, 0x78, 0x5c, 0x7c], [0, 1, 2, 19, 20, 21, 22, 23]],
]);

/** 128K read layouts, from `port82_w`. The key is the reversed read nibble. */
const LAYOUTS_128: Readonly<Record<number, Layout>> = layouts([
  [[0x00, 0x01], [0, 1, 2, 3, 4, 5, 6, 7]],
  [[0x02, 0x0a], [8, 9, 10, 11, 12, 13, 14, 15]],
  [[0x03, 0x07, 0x0b, 0x0f], [0, 1, 2, 11, 12, 13, 14, 7]],
  [[0x04, 0x06, 0x0c, 0x0e], [16, 17, 18, 19, 20, 21, 22, 23]],
  [[0x05, 0x0d], [0, 1, 2, 19, 20, 21, 22, 23]],
  [[0x08], [32, 33, 34, 35, 36, 37, 38, 39]],
  [[0x09], [0, 1, 2, 35, 36, 37, 38, 39]],
]);

/** The layouts whose slot 7 is the DOS ROM, and so gives way to page 15 when
 *  the FDC latch's bit 4 says so. */
const DOS_SLOT_KEYS_48 = new Set([0x20, 0x24, 0x28, 0x2c, 0x30, 0x34, 0x38, 0x3c]);
const DOS_SLOT_KEYS_128 = new Set([0x03, 0x07, 0x0b, 0x0f]);

/** Reverse the low four bits — MAME's `bitswap<8>(data, 0,0,0,0, 0,1,2,3)`. */
function reverseNibble(data: number): number {
  return ((data & 1) << 3) | ((data & 2) << 1) | ((data >> 1) & 2) | ((data >> 3) & 1);
}

export class LynxMemory {
  /** Every page of every bank, back to back. */
  readonly ram: Uint8Array;
  /** The page currently readable in each 8K slot of the Z80's 64K. */
  private readonly readPage = new Uint8Array(LYNX_PAGES);

  /** The bank port as last written, before the active-high correction. */
  private bankData = 0;
  /** Port 0x80 as last written — two of its bits join the 48K's bank decode. */
  private port80 = 0;
  /** Write enables: banks 1-4 in bits 0-3, and on the 48K/96K the two video
   *  vetoes from port 0x80 in bits 5-6. */
  private wbyte = 0;
  /** Port 0x58 bit 4 swaps RAM in over the DOS ROM slot. */
  private port58 = 0;

  readonly is128k: boolean;

  constructor(model: LynxModel) {
    this.is128k = model === 'lynx128';
    this.ram = new Uint8Array((this.is128k ? PAGES_128 : PAGES_48) * LYNX_PAGE_SIZE);
    this.ram.fill(0xff, 0, LYNX_PAGES * LYNX_PAGE_SIZE);
    this.reset();
  }

  /**
   * Load the system ROM images into bank 0 at their own addresses. `images`
   * are the 8K parts in order; `dos` is the optional disk-interface ROM.
   */
  loadRoms(images: readonly Uint8Array[], dos?: Uint8Array | null): void {
    // Bank 0 reads 0xFF where no ROM is fitted, as MAME's ERASEFF region does.
    this.ram.fill(0xff, 0, LYNX_PAGES * LYNX_PAGE_SIZE);
    images.forEach((image, index) => {
      const at = ROM_LOAD_OFFSETS[index];
      if (at === undefined) return;
      this.ram.set(image.subarray(0, LYNX_PAGE_SIZE), at);
    });
    if (dos) this.ram.set(dos.subarray(0, LYNX_PAGE_SIZE), DOS_ROM_OFFSET);
  }

  // ── Bank control ───────────────────────────────────────────────────────

  /** The bank port: 0x7F on the 48K/96K, 0x82 on the 128K. */
  writeBankPort(value: number): void {
    this.bankData = value & 0xff;
    this.applyBanks();
  }

  /** Port 0x80 — on the 48K/96K bits 2 and 3 join the decode, so re-apply. */
  setPort80(value: number): void {
    this.port80 = value & 0xff;
    if (!this.is128k) this.applyBanks();
  }

  /** Port 0x58 — the FDC latch, whose bit 4 pages RAM over the DOS ROM. */
  setPort58(value: number): void {
    this.port58 = value & 0xff;
    this.applyBanks();
  }

  private applyBanks(): void {
    const ramOverDos = (this.port58 & 0x10) !== 0;
    let layout: Layout | undefined;
    let dosSlot: boolean;

    if (this.is128k) {
      // d7-d4 are the write enables and d3-d0 the read enables, the reverse of
      // the 48K's order; d3 and d2 arrive active low.
      const data = (this.bankData ^ 0x8c) & 0xff;
      this.wbyte = reverseNibble(data >> 4);
      let rbyte = reverseNibble(data);
      // Bank 4 drops out when bank 2 is selected — an AND gate in IC82.
      if (rbyte & 0x02) rbyte &= 0x07;
      layout = LAYOUTS_128[rbyte];
      dosSlot = DOS_SLOT_KEYS_128.has(rbyte);
    } else {
      // Bits 0, 4 and 5 arrive active low; correct them so every enable reads
      // as "1 means on", which is what the tables are written against.
      const data = (this.bankData ^ 0x31) & 0xff;
      this.wbyte = (data & 0x0f) | ((this.port80 & 0x0c) << 3);
      const rbyte = (data & 0x70) | (this.port80 & 0x0c);
      layout = LAYOUTS_48[rbyte];
      dosSlot = DOS_SLOT_KEYS_48.has(rbyte);
    }

    if (!layout) return;   // a combination the decode cannot produce; leave as-is
    this.readPage.set(layout);
    if (dosSlot && ramOverDos) this.readPage[7] = 15;
  }

  // ── CPU access ─────────────────────────────────────────────────────────

  readByte(addr: number): number {
    const a = addr & 0xffff;
    return this.ram[this.readPage[a >> 13] * LYNX_PAGE_SIZE + (a & 0x1fff)];
  }

  /**
   * A store lands in every bank enabled for writing, all at once.
   *
   * On the 48K/96K the video banks leave A13 and A15 out of the decode, so one
   * store appears at four addresses and the display reads whichever of them the
   * plane lives at. The 128K decodes fully and writes one.
   */
  writeByte(addr: number, value: number): void {
    const a = addr & 0xffff;
    const v = value & 0xff;
    const w = this.wbyte;

    if (w & 0x01) this.ram[0x10000 + a] = v;              // bank 1, user RAM

    if (this.is128k) {
      if ((w & 0x22) === 0x02) this.ram[0x20000 + a] = v;   // bank 2, video
      if ((w & 0x44) === 0x04) this.ram[0x30000 + a] = v;   // bank 3
      if (w & 0x08) this.ram[0x40000 + a] = v;              // bank 4, extra RAM
      return;
    }

    const off = a & 0x5fff;
    if ((w & 0x22) === 0x02) {
      this.ram[0x20000 | off] = v;
      this.ram[0x22000 | off] = v;
      this.ram[0x28000 | off] = v;   // blue
      this.ram[0x2a000 | off] = v;
    }
    if ((w & 0x44) === 0x04) {
      this.ram[0x30000 | off] = v;
      this.ram[0x32000 | off] = v;
      this.ram[0x38000 | off] = v;   // alt green
      this.ram[0x3a000 | off] = v;
    }
  }

  /** Read straight out of a page, ignoring banking — for the video and debug. */
  readPageByte(page: number, offset: number): number {
    return this.ram[page * LYNX_PAGE_SIZE + (offset & 0x1fff)];
  }

  /** The page in each 8K slot, for the memory pane. */
  get pages(): Uint8Array { return this.readPage; }

  /** The write enables, for the memory pane. */
  get writeEnables(): number { return this.wbyte; }

  /** The 8K DOS ROM image, for the Memory pane's `rom-dos` region. */
  get dosRom(): Uint8Array {
    return this.ram.subarray(DOS_ROM_OFFSET, DOS_ROM_OFFSET + LYNX_PAGE_SIZE);
  }

  // ── IMachineMemory ─────────────────────────────────────────────────────

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte(addr + i);
    return out;
  }

  /** The 64K the CPU can currently see, flattened. */
  snapshot(): Uint8Array { return this.readBlock(0, 0x10000); }

  /** The whole physical RAM store, flattened — the raw `.bin` dump (256K on
   *  the 48K/96K, 320K on the 128K, matching MAME's RAM device). */
  ramSnapshot(): Uint8Array { return this.ram.slice(); }

  /** User RAM as 16K banks, starting at bank 1's first page. */
  getRamBank(n: number): Uint8Array {
    const bank = Math.min(Math.max(n, 0), this.ramBankCount - 1);
    const at = 0x10000 + bank * 0x4000;
    return this.ram.subarray(at, at + 0x4000);
  }

  get ramBankCount(): number { return this.is128k ? 12 : 8; }

  /** Reset writes 0 to the bank port with port 0x80 clear, which is what puts
   *  the ROM in the bottom 24K for the CPU to start in. */
  reset(): void {
    this.bankData = 0;
    this.port80 = 0;
    this.port58 = 0;
    this.applyBanks();
  }
}
