/**
 * MsxMemory — Toshiba HX-10 (MSX1) primary-slot paged memory.
 *
 * The MSX Z80 address space is four 16KB pages; each page independently selects
 * one of four *primary slots* via a 2-bit field in the 8255 PPI's port A
 * (0xA8) — bits [1:0] = page 0 (0x0000), [3:2] = page 1, [5:4] = page 2,
 * [7:6] = page 3. The HX-10's slot map is:
 *
 *   slot 0 — internal 32KB ROM (BIOS + MSX BASIC) at pages 0–1; pages 2–3 empty
 *   slot 1 — cartridge slot (empty on a bare machine → reads 0xFF; a mounted
 *            .rom cartridge maps here, from 0x4000 upward per its size)
 *   slot 2 — cartridge slot 2 (empty → reads 0xFF)
 *   slot 3 — 64KB RAM
 *
 * The HX-10 has no secondary-slot expansion, so the 0xFFFF expansion register
 * needs no handling — 0xFFFF is just the top of slot 3 RAM.
 *
 * At reset port A = 0x00, so every page points at slot 0: the BIOS runs from ROM
 * at 0x0000 and pages RAM (slot 3) into the upper pages during start-up.
 * Read/write are O(1) through per-page `readPtr`/`writePtr` views rebuilt only
 * when the slot register changes.
 */

import type { IMachineMemory } from '@/machines/machine.ts';

const ROM_SIZE = 0x8000;       // 32KB internal ROM (BIOS + BASIC)
const RAM_SIZE = 0x10000;      // 64KB RAM (slot 3)
const PAGE_SIZE = 0x4000;      // 16KB

export class MsxMemory implements IMachineMemory {
  /** Internal ROM: BIOS + MSX BASIC, mapped in slot 0 pages 0–1. */
  private rom = new Uint8Array(ROM_SIZE);

  /** 64KB main RAM (slot 3). */
  private readonly ram = new Uint8Array(RAM_SIZE);

  /** Primary-slot select register (PPI port A): 2 bits per page. */
  private primarySlot = 0;

  /** A mounted cartridge ROM (slot 1), or null. Kept for the debug/ROM pane. */
  private cartRom: Uint8Array | null = null;

  /** Per-page 16KB views of the cartridge as it appears in slot 1 (null = the
   *  cartridge doesn't cover that page). Rebuilt when the cartridge changes. */
  private readonly cartView: (Uint8Array | null)[] = [null, null, null, null];

  /** Per-page read source (16KB view) or null when the page is unmapped. */
  private readonly readPtr: (Uint8Array | null)[] = [null, null, null, null];
  /** Per-page write target (16KB view) or null when the page is read-only/empty. */
  private readonly writePtr: (Uint8Array | null)[] = [null, null, null, null];

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

  /** Mount a cartridge ROM into slot 1, mapped from 0x4000 by size. A reset
   *  afterwards lets the BIOS slot scan find and auto-run it. */
  insertCartridge(data: Uint8Array): void {
    this.cartRom = data.length > 0 ? data : null;
    this.buildCartViews();
    this.rebuild();
  }

  /** Remove any mounted cartridge from slot 1. */
  removeCartridge(): void {
    this.cartRom = null;
    this.buildCartViews();
    this.rebuild();
  }

  get hasCartridge(): boolean { return this.cartRom !== null; }
  get cartridgeSize(): number { return this.cartRom?.length ?? 0; }

  /**
   * Build the per-page cartridge views from the ROM size, following the standard
   * MSX cartridge placement (the "AB" header sits at the start, mapped to
   * 0x4000): ≤8KB mirrors across page 1; ≤16KB → page 1; ≤32KB → pages 1–2;
   * ≤48KB → pages 0–2. Larger images need a mega-ROM mapper (not yet supported);
   * their first 32KB is mapped at pages 1–2 as a best effort.
   */
  private buildCartViews(): void {
    this.cartView[0] = this.cartView[1] = this.cartView[2] = this.cartView[3] = null;
    const rom = this.cartRom;
    if (!rom) return;
    const size = rom.length;
    // A 16KB page copied from cart byte offset `off`, 0xFF-padded past the end.
    const slice16 = (off: number): Uint8Array => {
      const v = new Uint8Array(PAGE_SIZE).fill(0xFF);
      if (off < size) v.set(rom.subarray(off, Math.min(off + PAGE_SIZE, size)), 0);
      return v;
    };
    if (size <= 0x2000) {
      const v = new Uint8Array(PAGE_SIZE);
      v.set(rom.subarray(0, size), 0);
      v.set(rom.subarray(0, size), 0x2000);   // 8KB carts mirror across the page
      this.cartView[1] = v;
    } else if (size <= 0x4000) {
      this.cartView[1] = slice16(0);
    } else if (size <= 0x8000) {
      this.cartView[1] = slice16(0);
      this.cartView[2] = slice16(0x4000);
    } else if (size <= 0xC000) {
      this.cartView[0] = slice16(0);
      this.cartView[1] = slice16(0x4000);
      this.cartView[2] = slice16(0x8000);
    } else {
      this.cartView[1] = slice16(0);
      this.cartView[2] = slice16(0x4000);
    }
  }

  /** Rebuild the per-page read/write views from the slot register. */
  private rebuild(): void {
    for (let page = 0; page < 4; page++) {
      const slot = (this.primarySlot >> (page * 2)) & 3;
      const off = page * PAGE_SIZE;
      if (slot === 0) {
        // Slot 0: ROM in pages 0–1 (read-only), empty above.
        this.readPtr[page] = page < 2 ? this.rom.subarray(off, off + PAGE_SIZE) : null;
        this.writePtr[page] = null;
      } else if (slot === 3) {
        // Slot 3: 64KB RAM, read and write.
        const view = this.ram.subarray(off, off + PAGE_SIZE);
        this.readPtr[page] = view;
        this.writePtr[page] = view;
      } else if (slot === 1) {
        // Slot 1: a mounted cartridge (read-only), else empty.
        this.readPtr[page] = this.cartView[page];
        this.writePtr[page] = null;
      } else {
        // Slot 2: empty cartridge slot.
        this.readPtr[page] = null;
        this.writePtr[page] = null;
      }
    }
  }

  // ── IMachineMemory ───────────────────────────────────────────────────────

  readByte(addr: number): number {
    addr &= 0xFFFF;
    const ptr = this.readPtr[addr >> 14];
    return ptr ? ptr[addr & 0x3FFF] : 0xFF;
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    const ptr = this.writePtr[addr >> 14];
    if (ptr) ptr[addr & 0x3FFF] = val & 0xFF;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte((addr + i) & 0xFFFF);
    return out;
  }

  /** Fresh 64KB copy of the current paged address space (debug/snapshot). */
  snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    for (let page = 0; page < 4; page++) {
      const ptr = this.readPtr[page];
      if (ptr) out.set(ptr, page * PAGE_SIZE);
      else out.fill(0xFF, page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    }
    return out;
  }

  getRamBank(n: number): Uint8Array {
    const base = (n & 3) * PAGE_SIZE;
    return this.ram.subarray(base, base + PAGE_SIZE);
  }

  /** Fresh 64KB copy of the underlying RAM (slot 3), regardless of current
   *  slot paging — where a running program keeps its code/data. */
  ramSnapshot(): Uint8Array {
    return this.ram.slice();
  }

  reset(): void {
    this.ram.fill(0);
    this.primarySlot = 0;
    this.rebuild();
  }
}
