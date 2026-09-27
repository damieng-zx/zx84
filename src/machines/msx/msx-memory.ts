/**
 * MsxMemory — Toshiba HX-10 (MSX1) primary-slot paged memory.
 *
 * The MSX Z80 address space is four 16KB pages; each page independently selects
 * one of four *primary slots* via a 2-bit field in the 8255 PPI's port A
 * (0xA8) — bits [1:0] = page 0 (0x0000), [3:2] = page 1, [5:4] = page 2,
 * [7:6] = page 3. The HX-10's slot map (MAME msx1.cpp / openMSX
 * Toshiba_HX-10.xml) is:
 *
 *   slot 0 — internal 32KB ROM (BIOS + MSX BASIC) at pages 0–1; pages 2–3 empty
 *   slot 1 — cartridge slot (empty on a bare machine → reads 0xFF; a mounted
 *            .rom cartridge maps here, placed by its "AB" header — see
 *            guessCartBase)
 *   slot 2 — 64KB RAM
 *   slot 3 — the rear expansion connector; unpopulated here → reads 0xFF,
 *            same as an empty cartridge slot (no expansion unit is modelled)
 *
 * The HX-10 has no secondary-slot expansion, so the 0xFFFF expansion register
 * needs no handling — 0xFFFF is just the top of slot 2 RAM.
 *
 * At reset port A = 0x00, so every page points at slot 0: the BIOS runs from ROM
 * at 0x0000 and pages RAM (slot 2) into the upper pages during start-up.
 * Read/write are O(1) through per-8KB-segment `readPtr`/`writePtr` views
 * rebuilt only when the slot register (or a cartridge bank) changes. 8KB
 * granularity matches the smallest mega-ROM bank.
 */

import type { IMachineMemory } from '@/machines/machine.ts';

const ROM_SIZE = 0x8000;       // 32KB internal ROM (BIOS + BASIC)
const RAM_SIZE = 0x10000;      // 64KB RAM (slot 2)
const PAGE_SIZE = 0x4000;      // 16KB slot-select page
const SEG_SIZE = 0x2000;       // 8KB lookup segment
const SEGS = 8;

/**
 * Where a plain (non-mapper) cartridge image starts in the Z80 address space,
 * from its "AB" header(s) — the openMSX RomPlain::guessLocation rule. Every
 * 16KB boundary of the image is checked for "AB"; each non-zero pointer in the
 * header (INIT, STATEMENT, DEVICE, TEXT) votes for the page the image must
 * start at so the pointer lands inside its own 16KB block. 0x4000 is preferred,
 * then 0x0000, then 0x8000; no header at all defaults to 0x4000.
 *
 * So a 48KB image with its header at file offset 0x4000 (INIT 0x4xxx) lays out
 * at 0x0000–0xBFFF, and a BASIC cartridge (INIT 0, TEXT 0x8xxx) sits at 0x8000.
 */
export function guessCartBase(rom: Uint8Array): number {
  const votes = [0, 0, 0];
  for (let i = 0; i + 0x10 <= rom.length; i += PAGE_SIZE) {
    if (rom[i] !== 0x41 || rom[i + 1] !== 0x42) continue;   // "AB"
    for (let j = 0; j < 4; j++) {
      const w = rom[i + 2 + j * 2] | (rom[i + 3 + j * 2] << 8);
      if (w === 0) continue;
      const page = (w >> 14) - (i >> 14);
      if (page >= 0 && page <= 2) votes[page]++;
    }
  }
  if (votes[1] && votes[1] >= votes[0] && votes[1] >= votes[2]) return 0x4000;
  if (votes[0] && votes[0] >= votes[2]) return 0x0000;
  if (votes[2]) return 0x8000;
  return 0x4000;
}

/** How slot 1 decodes the cartridge: a plain ROM, or one of the common
 *  mega-ROM bank mappers (openMSX RomAscii8kB/RomAscii16kB/RomKonami/
 *  RomKonamiSCC). SCC sound is not modelled — only its bank switching. */
export type MsxMapper = 'plain' | 'ascii8' | 'ascii16' | 'konami' | 'konami-scc';

/**
 * Guess a mega-ROM's mapper the way openMSX's RomFactory does: games switch
 * banks with `LD (nnnn),A` (opcode 0x32), so count those stores to each
 * mapper's register addresses and pick the most-hit mapper. Ties go to
 * Konami SCC, then Konami, ASCII16, ASCII8; ASCII8's count is docked by one
 * as in openMSX, and a ROM with no hits at all falls back to ASCII8 (the
 * nearest supported layout to openMSX's generic 8KB mapper).
 */
export function guessMegaRomMapper(rom: Uint8Array): Exclude<MsxMapper, 'plain'> {
  let ascii8 = 0, ascii16 = 0, konami = 0, konamiScc = 0;
  for (let i = 0; i + 3 < rom.length; i++) {
    if (rom[i] !== 0x32) continue;
    switch (rom[i + 1] | (rom[i + 2] << 8)) {
      case 0x5000: case 0x9000: case 0xB000: konamiScc++; break;
      case 0x4000: case 0x8000: case 0xA000: konami++; break;
      case 0x6800: case 0x7800: ascii8++; break;
      case 0x6000: konami++; ascii8++; ascii16++; break;
      case 0x7000: konamiScc++; ascii8++; ascii16++; break;
      case 0x77FF: ascii16++; break;
    }
  }
  if (ascii8 > 0) ascii8--;
  let best: Exclude<MsxMapper, 'plain'> = 'ascii8';
  let bestCount = ascii8;
  const rivals = [['ascii16', ascii16], ['konami', konami], ['konami-scc', konamiScc]] as const;
  for (const [type, count] of rivals) {
    if (count > 0 && count >= bestCount) { best = type; bestCount = count; }
  }
  return best;
}

/** Whether an image needs a mega-ROM mapper: anything over 64KB, or a 64KB
 *  image that starts with an "AB" header (openMSX: a header-less 64KB image
 *  is a plain ROM filling all four pages). */
export function isMegaRom(rom: Uint8Array): boolean {
  if (rom.length > 0x10000) return true;
  return rom.length === 0x10000 && rom[0] === 0x41 && rom[1] === 0x42;
}

export class MsxMemory implements IMachineMemory {
  /** Internal ROM: BIOS + MSX BASIC, mapped in slot 0 pages 0–1. */
  private rom = new Uint8Array(ROM_SIZE);

  /** 64KB main RAM (slot 2). */
  private readonly ram = new Uint8Array(RAM_SIZE);

  /** Primary-slot select register (PPI port A): 2 bits per page. */
  private primarySlot = 0;

  /** A mounted cartridge ROM (slot 1), or null. Kept for the debug/ROM pane. */
  private cartRom: Uint8Array | null = null;

  /** Per-8KB-segment views of the cartridge as it appears in slot 1 (null =
   *  the cartridge doesn't decode that segment). */
  private readonly cartSeg: (Uint8Array | null)[] = new Array(SEGS).fill(null);

  /** The cartridge's mapper, and (for mega-ROMs) its image padded to whole
   *  8KB blocks plus the bank-number mask (next power of two, minus one). */
  private mapper: MsxMapper = 'plain';
  private cartImage = new Uint8Array(0);
  private cartBlocks8 = 0;
  private cartMask8 = 0;
  /** Segments where a CPU write reaches the mapper's bank registers (slot 1
   *  selected there and a mega-ROM mounted). */
  private readonly mapperSeg = new Uint8Array(SEGS);

  /** Per-segment read source (8KB view) or null when unmapped (reads 0xFF). */
  private readonly readPtr: (Uint8Array | null)[] = new Array(SEGS).fill(null);
  /** Per-segment write target (8KB view) or null when read-only/empty. */
  private readonly writePtr: (Uint8Array | null)[] = new Array(SEGS).fill(null);

  constructor() {
    this.rebuild();
  }

  /** Install the internal ROM image (clamped/padded to 32KB) and remap. */
  loadROM(data: Uint8Array): void {
    this.rom = new Uint8Array(ROM_SIZE);
    this.rom.set(data.subarray(0, ROM_SIZE));
    this.rebuild();
  }

  /** Write the PPI port-A primary-slot select register and remap. */
  setPrimarySlots(val: number): void {
    this.primarySlot = val & 0xFF;
    this.rebuild();
  }

  /** Current primary-slot register (debug/memory viewer). */
  getPrimarySlot(): number { return this.primarySlot; }

  /** Live 32KB view of the internal ROM (debug/memory viewer). */
  getRom(): Uint8Array { return this.rom; }

  /** Mount a cartridge ROM into slot 1: a mega-ROM gets its mapper
   *  (`mapper`, else guessed from the code), a plain ROM is placed by its
   *  header. A reset afterwards lets the BIOS slot scan find and auto-run it. */
  insertCartridge(data: Uint8Array, mapper?: MsxMapper): void {
    this.cartRom = data.length > 0 ? data : null;
    if (this.cartRom === null) this.mapper = 'plain';
    else if (mapper !== undefined) this.mapper = mapper;
    else this.mapper = isMegaRom(this.cartRom) ? guessMegaRomMapper(this.cartRom) : 'plain';
    this.buildCartViews();
    this.rebuild();
  }

  /** Remove any mounted cartridge from slot 1. */
  removeCartridge(): void {
    this.cartRom = null;
    this.mapper = 'plain';
    this.buildCartViews();
    this.rebuild();
  }

  get hasCartridge(): boolean { return this.cartRom !== null; }
  get cartridgeSize(): number { return this.cartRom?.length ?? 0; }
  /** The mounted cartridge's mapper ('plain' when none or unbanked). */
  get cartridgeMapper(): MsxMapper { return this.mapper; }

  /** Whether the cartridge decodes any part of 16KB page `page` (0–3). */
  cartCoversPage(page: number): boolean {
    return this.cartSeg[page * 2] !== null || this.cartSeg[page * 2 + 1] !== null;
  }

  /**
   * Lay a plain cartridge image into slot 1. The start page comes from the
   * "AB" header ({@link guessCartBase}); the image then covers as many 16KB
   * pages as it needs, up to 0xFFFF. An 8KB image mirrors across its 16KB
   * page (only A0–A12 are decoded). A 64KB image fills all four pages.
   */
  private buildCartViews(): void {
    this.cartSeg.fill(null);
    const rom = this.cartRom;
    if (!rom) return;
    if (this.mapper !== 'plain') { this.buildMegaRom(rom); return; }
    const size = rom.length;
    const base = size >= 0x10000 ? 0 : guessCartBase(rom);
    const pages = Math.min(Math.ceil(size / PAGE_SIZE), 4 - (base >> 14));
    const image = new Uint8Array(pages * PAGE_SIZE).fill(0xFF);
    image.set(rom.subarray(0, image.length));
    if (size <= SEG_SIZE) image.set(rom, SEG_SIZE);   // 8KB mirrors in its page
    const firstSeg = base >> 13;
    for (let i = 0; i < pages * 2; i++) {
      this.cartSeg[firstSeg + i] = image.subarray(i * SEG_SIZE, (i + 1) * SEG_SIZE);
    }
  }

  /** Pad a mega-ROM to whole 8KB blocks and power it up with its mapper's
   *  reset banking. */
  private buildMegaRom(rom: Uint8Array): void {
    const blocks = Math.ceil(rom.length / SEG_SIZE);
    this.cartImage = new Uint8Array(blocks * SEG_SIZE).fill(0xFF);
    this.cartImage.set(rom);
    this.cartBlocks8 = blocks;
    let pow = 1;
    while (pow < blocks) pow <<= 1;
    this.cartMask8 = pow - 1;
    this.resetMapper();
  }

  /** 8KB block `n` (already masked) of the mega-ROM, or null past its end. */
  private block8(n: number): Uint8Array | null {
    return n < this.cartBlocks8 ? this.cartImage.subarray(n * SEG_SIZE, (n + 1) * SEG_SIZE) : null;
  }

  /** Map 8KB bank `bank` at segment `seg` (bank masked to the ROM size). */
  private setBank8(seg: number, bank: number): void {
    this.cartSeg[seg] = this.block8(bank & this.cartMask8);
  }

  /** Map 16KB bank `bank` at segments `seg`/`seg+1` (ASCII16). */
  private setBank16(seg: number, bank: number): void {
    const n = (bank & (this.cartMask8 >> 1)) * 2;
    this.cartSeg[seg] = this.block8(n);
    this.cartSeg[seg + 1] = this.block8(n + 1);
  }

  /** Power-on banking. Every mapper decodes 0x4000–0xBFFF only; pages 0 and
   *  3 are unmapped (openMSX). */
  private resetMapper(): void {
    this.cartSeg.fill(null);
    switch (this.mapper) {
      case 'ascii8':
        for (let seg = 2; seg < 6; seg++) this.setBank8(seg, 0);
        break;
      case 'ascii16':
        this.setBank16(2, 0);
        this.setBank16(4, 0);
        break;
      case 'konami':
      case 'konami-scc':
        for (let seg = 2; seg < 6; seg++) this.setBank8(seg, seg - 2);
        break;
      case 'plain':
        break;
    }
  }

  /** A CPU write into slot 1 of a mega-ROM: decode the bank registers. */
  private mapperWrite(addr: number, val: number): void {
    switch (this.mapper) {
      case 'ascii8':
        // 0x6000/0x6800/0x7000/0x7800 (2KB windows) → banks at 0x4000–0xA000.
        if (addr < 0x6000 || addr >= 0x8000) return;
        this.setBank8(2 + ((addr >> 11) & 3), val);
        break;
      case 'ascii16':
        // 0x6000–0x67FF → the 0x4000 bank; 0x7000–0x77FF → the 0x8000 bank.
        if (addr < 0x6000 || addr >= 0x7800 || (addr & 0x0800)) return;
        this.setBank16((addr & 0x1000) ? 4 : 2, val);
        break;
      case 'konami':
        // 0x4000–0x5FFF is fixed to bank 0; a write anywhere in 0x6000–
        // 0xBFFF selects the bank for that 8KB segment.
        if (addr < 0x6000 || addr >= 0xC000) return;
        this.setBank8(addr >> 13, val);
        break;
      case 'konami-scc':
        // 0x5000/0x7000/0x9000/0xB000 (2KB windows) → banks at 0x4000–0xA000.
        if (addr < 0x5000 || addr >= 0xC000 || (addr & 0x1800) !== 0x1000) return;
        this.setBank8(addr >> 13, val);
        break;
      case 'plain':
        return;
    }
    this.rebuild();
  }

  /** Rebuild the per-segment read/write views from the slot register. */
  private rebuild(): void {
    const mega = this.mapper !== 'plain' ? 1 : 0;
    for (let seg = 0; seg < SEGS; seg++) {
      const page = seg >> 1;
      const slot = (this.primarySlot >> (page * 2)) & 3;
      const off = seg * SEG_SIZE;
      // A mega-ROM's bank registers catch CPU writes anywhere in slot 1.
      this.mapperSeg[seg] = slot === 1 ? mega : 0;
      if (slot === 0) {
        // Slot 0: ROM in pages 0–1 (read-only), empty above.
        this.readPtr[seg] = page < 2 ? this.rom.subarray(off, off + SEG_SIZE) : null;
        this.writePtr[seg] = null;
      } else if (slot === 2) {
        // Slot 2: 64KB RAM, read and write.
        const view = this.ram.subarray(off, off + SEG_SIZE);
        this.readPtr[seg] = view;
        this.writePtr[seg] = view;
      } else if (slot === 1) {
        // Slot 1: a mounted cartridge (read-only), else empty.
        this.readPtr[seg] = this.cartSeg[seg];
        this.writePtr[seg] = null;
      } else {
        // Slot 3: the (unmodelled) rear expansion connector — reads 0xFF.
        this.readPtr[seg] = null;
        this.writePtr[seg] = null;
      }
    }
  }

  // ── IMachineMemory ───────────────────────────────────────────────────────

  readByte(addr: number): number {
    addr &= 0xFFFF;
    const ptr = this.readPtr[addr >> 13];
    return ptr ? ptr[addr & 0x1FFF] : 0xFF;
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    const seg = addr >> 13;
    const ptr = this.writePtr[seg];
    if (ptr) ptr[addr & 0x1FFF] = val & 0xFF;
    else if (this.mapperSeg[seg]) this.mapperWrite(addr, val & 0xFF);
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte((addr + i) & 0xFFFF);
    return out;
  }

  /** Fresh 64KB copy of the current paged address space (debug/snapshot). */
  snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    for (let seg = 0; seg < SEGS; seg++) {
      const ptr = this.readPtr[seg];
      if (ptr) out.set(ptr, seg * SEG_SIZE);
      else out.fill(0xFF, seg * SEG_SIZE, (seg + 1) * SEG_SIZE);
    }
    return out;
  }

  getRamBank(n: number): Uint8Array {
    const base = (n & 3) * PAGE_SIZE;
    return this.ram.subarray(base, base + PAGE_SIZE);
  }

  /** A flat 64K of RAM in slot 2, presented as four 16K banks. */
  readonly ramBankCount = 4;

  /** Fresh 64KB copy of the underlying RAM (slot 2), regardless of current
   *  slot paging — where a running program keeps its code/data. */
  ramSnapshot(): Uint8Array {
    return this.ram.slice();
  }

  reset(): void {
    this.ram.fill(0);
    this.primarySlot = 0;
    if (this.mapper !== 'plain') this.resetMapper();   // /RESET reaches the cart
    this.rebuild();
  }
}
