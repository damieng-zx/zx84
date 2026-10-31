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
 *   slot 3 — the rear expansion connector: empty (reads 0xFF) unless the
 *            optional floppy disk interface is fitted, which puts its 16KB Disk
 *            BASIC ROM in page 1 (mirrored in page 2) with the WD2793 registers
 *            overlaying the top of it (see peripherals/disk-interface.ts)
 *
 * The HX-10 has no secondary-slot expansion, so the 0xFFFF expansion register
 * needs no handling — 0xFFFF is just the top of slot 2 RAM. Expansion is
 * supported generically behind {@link MsxMemoryLayout.expansions} (no shipped
 * model sets it): a slot with sub-slots has an expansion register at 0xFFFF,
 * visible whenever that slot is selected in page 3. Writing stores two bits per
 * page choosing the sub-slot; reading returns the stored value inverted.
 *
 * Other MSX1 models rearrange the on-board memory (see {@link MsxMemoryLayout}):
 * the Sony HB-55 keeps its 16KB of RAM in slot 0 page 3 (0xC000–0xFFFF) and adds
 * an 8KB Personal Data Bank ROM in slot 0 page 2 (0x8000–0x9FFF). It has no
 * sub-slots either.
 *
 * At reset port A = 0x00, so every page points at slot 0: the BIOS runs from ROM
 * at 0x0000 and pages RAM (slot 2) into the upper pages during start-up.
 * Read/write are O(1) through per-8KB-segment `readPtr`/`writePtr` views
 * rebuilt only when the slot register (or a cartridge bank) changes. 8KB
 * granularity matches the smallest mega-ROM bank.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import type { MsxDiskInterface } from '@/machines/msx/peripherals/disk-interface.ts';
import {
  MsxCartridge, guessMegaRomMapper, isMegaRom, isMsxMapper, type MsxMapper,
} from '@/machines/msx/msx-cartridge.ts';

export { guessCartBase, guessMegaRomMapper, isMegaRom, MSX_MAPPERS, type MsxMapper } from '@/machines/msx/msx-cartridge.ts';

const ROM_SIZE = 0x8000;       // 32KB internal ROM (BIOS + BASIC)
const PAGE_SIZE = 0x4000;      // 16KB slot-select page
const SEG_SIZE = 0x2000;       // 8KB lookup segment
const SEGS = 8;

/** How a model arranges its on-board RAM and firmware across the primary slots. */
export interface MsxMemoryLayout {
  /** Primary slot holding the RAM (HX-10: 2, HB-55: 0). */
  readonly ramSlot: number;
  /** First 16KB page of the RAM; it runs up to 0xFFFF (HX-10: 0 = 64KB, HB-55:
   *  3 = 16KB at 0xC000). */
  readonly ramFirstPage: number;
  /** 16KB page of slot 0 that holds the optional firmware ROM (HB-55/55P: 2),
   *  or null when the model has none. */
  readonly firmwarePage: number | null;
  /** Primary slots expanded into four sub-slots (the config flag: absent on
   *  every model that ships today). Keyed by primary slot; each entry says which
   *  of the machine's native slot contents (0 = ROM/firmware/RAM-in-slot-0,
   *  1 = cartridge, 2/3 = slot 2/3 contents) appears in that sub-slot. A page
   *  selects its sub-slot through the expansion register at 0xFFFF. */
  readonly expansions?: Readonly<Record<number, readonly [number, number, number, number]>>;
}

/** The HX-10 arrangement: 32KB ROM in slot 0, 64KB RAM in slot 2. */
export const MSX_DEFAULT_LAYOUT: MsxMemoryLayout = { ramSlot: 2, ramFirstPage: 0, firmwarePage: null };

export class MsxMemory implements IMachineMemory {
  /** Internal ROM: BIOS + MSX BASIC, mapped in slot 0 pages 0–1. */
  private rom = new Uint8Array(ROM_SIZE);

  /** Main RAM — 64KB in slot 2 on the HX-10, 16KB in slot 0 page 3 on the HB-55. */
  private readonly ram: Uint8Array;

  /** Optional on-board firmware ROM (HB-55 Personal Data Bank, 8KB; HB-55P,
   *  16KB), slot 0. Held as a whole 16KB page, 0xFF-padded. */
  private firmware: Uint8Array | null = null;

  /** Primary-slot select register (PPI port A): 2 bits per page. */
  private primarySlot = 0;

  /** Expansion register of each primary slot (2 bits per page), as stored; the
   *  CPU reads the complement back at 0xFFFF. All zero at reset. */
  private readonly subSlot = new Uint8Array(4);
  /** Segments served by the expansion-register slow path (only ever segment 7,
   *  when the slot selected in page 3 is expanded), and that segment's normal
   *  read/write views. */
  private readonly expSeg = new Uint8Array(SEGS);
  private expRead: Uint8Array | null = null;
  private expWrite: Uint8Array | null = null;

  /** The cartridge in slot 1 (empty when its `rom` is null). */
  readonly cart = new MsxCartridge();
  /** Segments where a CPU write reaches the cartridge (slot 1 selected there
   *  and a mega-ROM mounted: bank registers, SRAM, the SCC). */
  private readonly mapperSeg = new Uint8Array(SEGS);
  /** Segments whose reads go through the cartridge's slow path (the SCC). */
  private readonly cartSlowSeg = new Uint8Array(SEGS);

  /** The floppy disk interface in slot 3, or null when not fitted. */
  private disk: MsxDiskInterface | null = null;
  /** Segments whose accesses are routed to {@link disk} (its register page). */
  private readonly diskSeg = new Uint8Array(SEGS);

  /** Per-segment read source (8KB view) or null when unmapped (reads 0xFF). */
  private readonly readPtr: (Uint8Array | null)[] = new Array(SEGS).fill(null);
  /** Per-segment write target (8KB view) or null when read-only/empty. */
  private readonly writePtr: (Uint8Array | null)[] = new Array(SEGS).fill(null);

  constructor(private readonly layout: MsxMemoryLayout = MSX_DEFAULT_LAYOUT) {
    this.ram = new Uint8Array((4 - layout.ramFirstPage) * PAGE_SIZE);
    this.rebuild();
  }

  /** Install the internal ROM image (clamped/padded to 32KB) and remap. */
  loadROM(data: Uint8Array): void {
    this.rom = new Uint8Array(ROM_SIZE);
    this.rom.set(data.subarray(0, ROM_SIZE));
    this.rebuild();
  }

  /** Install the on-board firmware ROM, up to 16KB (models with a firmware page only). */
  loadFirmware(data: Uint8Array): void {
    if (this.layout.firmwarePage === null) return;
    this.firmware = new Uint8Array(PAGE_SIZE).fill(0xFF);
    this.firmware.set(data.subarray(0, PAGE_SIZE));
    this.rebuild();
  }

  get hasFirmware(): boolean { return this.firmware !== null; }

  /** Whether the on-board RAM sits in 16KB page `page` of primary slot `slot`. */
  ramCoversPage(slot: number, page: number): boolean {
    return slot === this.layout.ramSlot && page >= this.layout.ramFirstPage;
  }

  /** Whether the firmware ROM sits in 16KB page `page` of primary slot `slot`. */
  firmwareCoversPage(slot: number, page: number): boolean {
    return this.firmware !== null && slot === 0 && page === this.layout.firmwarePage;
  }

  /** Live view of the firmware ROM (debug/memory viewer), or null. */
  getFirmware(): Uint8Array | null { return this.firmware; }

  /** Write the PPI port-A primary-slot select register and remap. */
  setPrimarySlots(val: number): void {
    this.primarySlot = val & 0xFF;
    this.rebuild();
  }

  /** Current primary-slot register (debug/memory viewer). */
  getPrimarySlot(): number { return this.primarySlot; }

  /** Fit (or, with null, remove) the floppy disk interface in slot 3. */
  setDiskInterface(disk: MsxDiskInterface | null): void {
    this.disk = disk;
    this.rebuild();
  }

  get hasDiskInterface(): boolean { return this.disk !== null; }

  /** Live 32KB view of the internal ROM (debug/memory viewer). */
  getRom(): Uint8Array { return this.rom; }

  /** Mount a cartridge ROM into slot 1: a mega-ROM gets its mapper
   *  (`mapper`, else guessed from the code), a plain ROM is placed by its
   *  header. A reset afterwards lets the BIOS slot scan find and auto-run it. */
  insertCartridge(data: Uint8Array, mapper?: MsxMapper): void {
    const rom = data.length > 0 ? data : null;
    const type: MsxMapper = rom === null ? 'plain'
      : mapper !== undefined ? mapper
      : isMegaRom(rom) ? guessMegaRomMapper(rom) : 'plain';
    this.cart.insert(rom, type);
    this.rebuild();
  }

  /** Remove any mounted cartridge from slot 1. */
  removeCartridge(): void {
    this.cart.insert(null, 'plain');
    this.rebuild();
  }

  get hasCartridge(): boolean { return this.cart.rom !== null; }
  get cartridgeSize(): number { return this.cart.rom?.length ?? 0; }
  /** The mounted cartridge's mapper ('plain' when none or unbanked). */
  get cartridgeMapper(): MsxMapper { return this.cart.mapper; }
  /** The mounted cartridge image, or null. */
  get cartridgeRom(): Uint8Array | null { return this.cart.rom; }

  /** Whether the cartridge decodes any part of 16KB page `page` (0–3). */
  cartCoversPage(page: number): boolean {
    return this.cart.seg[page * 2] !== null || this.cart.seg[page * 2 + 1] !== null;
  }

  /** A CPU write into slot 1 of a mega-ROM. */
  private mapperWrite(addr: number, val: number): void {
    if (this.cart.write(addr, val)) this.rebuild();
  }

  /** Re-read the cartridge's views (after a snapshot restore changed them). */
  refreshCartridge(): void { this.rebuild(); }

  /** Rebuild the per-segment read/write views from the slot register(s). */
  private rebuild(): void {
    const mega = this.cart.isMega ? 1 : 0;
    for (let seg = 0; seg < SEGS; seg++) {
      const page = seg >> 1;
      const slot = (this.primarySlot >> (page * 2)) & 3;
      this.expSeg[seg] = 0;
      const sub = this.layout.expansions?.[slot];
      // In an expanded slot the page's sub-slot register field picks which of
      // the machine's native slot contents appears here.
      const src = sub ? sub[(this.subSlot[slot] >> (page * 2)) & 3] : slot;
      this.mapSegment(seg, src, mega);
      if (sub && seg === 7) {
        // 0xFFFF belongs to the expansion register, so the top segment goes
        // through the slow path; its normal contents are kept aside.
        this.expSeg[7] = 1;
        this.expRead = this.readPtr[7];
        this.expWrite = this.writePtr[7];
        this.readPtr[7] = null;
        this.writePtr[7] = null;
      }
    }
  }

  /** Point segment `seg` at the contents of (native) slot `slot`. */
  private mapSegment(seg: number, slot: number, mega: number): void {
    const page = seg >> 1;
    const off = seg * SEG_SIZE;
    // A mega-ROM's bank registers catch CPU writes anywhere in slot 1.
    this.mapperSeg[seg] = slot === 1 ? mega : 0;
    this.diskSeg[seg] = 0;
    this.cartSlowSeg[seg] = 0;
    if (slot === this.layout.ramSlot && page >= this.layout.ramFirstPage) {
      // On-board RAM, read and write (HX-10: slot 2 pages 0–3; HB-55: slot 0
      // page 3). It is indexed from the first RAM page.
      const rel = off - this.layout.ramFirstPage * PAGE_SIZE;
      const view = this.ram.subarray(rel, rel + SEG_SIZE);
      this.readPtr[seg] = view;
      this.writePtr[seg] = view;
    } else if (slot === 0) {
      // Slot 0: ROM in pages 0–1 (read-only); the firmware ROM fills its page
      // (an 8KB image leaves the upper half reading 0xFF); empty otherwise.
      if (page < 2) this.readPtr[seg] = this.rom.subarray(off, off + SEG_SIZE);
      else if (this.firmware !== null && page === this.layout.firmwarePage) {
        this.readPtr[seg] = this.firmware.subarray((seg & 1) * SEG_SIZE, ((seg & 1) + 1) * SEG_SIZE);
      } else this.readPtr[seg] = null;
      this.writePtr[seg] = null;
    } else if (slot === 2) {
      // Slot 2 holds no RAM on this model: empty.
      this.readPtr[seg] = null;
      this.writePtr[seg] = null;
    } else if (slot === 1) {
      // Slot 1: a mounted cartridge (read-only; SRAM and the SCC take their
      // writes through mapperWrite), else empty. The SCC window reads through
      // the cartridge's slow path.
      if (this.cart.slow[seg]) {
        this.readPtr[seg] = null;
        this.cartSlowSeg[seg] = 1;
      } else {
        this.readPtr[seg] = this.cart.seg[seg];
      }
      this.writePtr[seg] = null;
    } else if (this.disk !== null && (seg === 2 || seg === 4)) {
      // Slot 3 with the disk interface: the first half of its Disk BASIC ROM
      // is plain read-only memory (the card decodes pages 1 and 2 alike)...
      this.readPtr[seg] = this.disk.getRom().subarray(0, SEG_SIZE);
      this.writePtr[seg] = null;
    } else if (this.disk !== null && (seg === 3 || seg === 5)) {
      // ...the second half carries the controller's registers, so every
      // access is routed through the interface (null pointer = slow path).
      this.readPtr[seg] = null;
      this.writePtr[seg] = null;
      this.diskSeg[seg] = 1;
    } else {
      // Slot 3 otherwise: the rear expansion connector, empty — reads 0xFF.
      this.readPtr[seg] = null;
      this.writePtr[seg] = null;
    }
  }

  /** Whether primary slot `slot` is expanded into four sub-slots on this model. */
  isExpanded(slot: number): boolean {
    return this.layout.expansions?.[slot] !== undefined;
  }

  /** The expansion register of primary slot `slot` as the CPU reads it back at
   *  0xFFFF (the complement of the stored value), or 0xFF if not expanded. */
  getExpansionRegister(slot: number): number {
    return this.isExpanded(slot) ? (~this.subSlot[slot]) & 0xFF : 0xFF;
  }

  /** Slow-path read of the top segment of an expanded page 3. */
  private readTop(addr: number): number {
    if (addr === 0xFFFF) return (~this.subSlot[(this.primarySlot >> 6) & 3]) & 0xFF;
    return this.expRead ? this.expRead[addr & 0x1FFF] : 0xFF;
  }

  /** Write to the expansion register (0xFFFF) of the slot selected in page 3. */
  private writeTop(addr: number, val: number): void {
    if (addr === 0xFFFF) {
      this.subSlot[(this.primarySlot >> 6) & 3] = val & 0xFF;
      this.rebuild();
    } else if (this.expWrite) {
      this.expWrite[addr & 0x1FFF] = val & 0xFF;
    } else if (this.mapperSeg[7]) {
      this.mapperWrite(addr, val & 0xFF);
    }
  }

  // ── IMachineMemory ───────────────────────────────────────────────────────

  readByte(addr: number): number {
    addr &= 0xFFFF;
    const seg = addr >> 13;
    const ptr = this.readPtr[seg];
    if (ptr) return ptr[addr & 0x1FFF];
    if (this.expSeg[seg]) return this.readTop(addr);
    if (this.cartSlowSeg[seg]) return this.cart.read(addr);
    return this.diskSeg[seg] ? this.disk!.read(addr) : 0xFF;
  }

  /** Read with no side effects: the disk controller's registers (a data-register
   *  read pops a byte) read as 0xFF. For debug views and the disassembler. */
  peekByte(addr: number): number {
    addr &= 0xFFFF;
    const seg = addr >> 13;
    const ptr = this.readPtr[seg];
    if (ptr) return ptr[addr & 0x1FFF];
    if (this.expSeg[seg]) return this.readTop(addr);
    if (this.cartSlowSeg[seg]) return this.cart.peek(addr);
    return this.diskSeg[seg] ? this.disk!.peek(addr) : 0xFF;
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    const seg = addr >> 13;
    const ptr = this.writePtr[seg];
    if (ptr) ptr[addr & 0x1FFF] = val & 0xFF;
    else if (this.expSeg[seg]) this.writeTop(addr, val);
    else if (this.mapperSeg[seg]) this.mapperWrite(addr, val & 0xFF);
    else if (this.diskSeg[seg]) this.disk!.write(addr, val & 0xFF);
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.peekByte((addr + i) & 0xFFFF);
    return out;
  }

  /** Fresh 64KB copy of the current paged address space (debug/snapshot). */
  snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    for (let seg = 0; seg < SEGS; seg++) {
      const ptr = this.readPtr[seg];
      if (ptr) out.set(ptr, seg * SEG_SIZE);
      else if (this.expSeg[seg]) {
        for (let i = 0; i < SEG_SIZE; i++) out[seg * SEG_SIZE + i] = this.readTop(seg * SEG_SIZE + i);
      } else if (this.cartSlowSeg[seg]) {
        for (let i = 0; i < SEG_SIZE; i++) out[seg * SEG_SIZE + i] = this.cart.peek(seg * SEG_SIZE + i);
      } else if (this.diskSeg[seg]) {
        for (let i = 0; i < SEG_SIZE; i++) out[seg * SEG_SIZE + i] = this.disk!.peek(seg * SEG_SIZE + i);
      } else out.fill(0xFF, seg * SEG_SIZE, (seg + 1) * SEG_SIZE);
    }
    return out;
  }

  getRamBank(n: number): Uint8Array {
    const count = this.ramBankCount;
    const base = (((n % count) + count) % count) * PAGE_SIZE;
    return this.ram.subarray(base, base + PAGE_SIZE);
  }

  /** The on-board RAM presented as 16K banks (HX-10: 4, HB-55: 1). */
  get ramBankCount(): number { return 4 - this.layout.ramFirstPage; }

  /** Fresh 64KB image of the RAM at its CPU addresses (zero below the first RAM
   *  page), regardless of current slot paging — where a running program keeps
   *  its code/data, and the address space BASIC's tables are parsed from. */
  ramSnapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    out.set(this.ram, this.layout.ramFirstPage * PAGE_SIZE);
    return out;
  }

  /** Fresh copy of just the physical RAM (HX-10: 64KB, HB-55: 16KB). */
  ramBytes(): Uint8Array { return this.ram.slice(); }

  reset(): void {
    this.ram.fill(0);
    this.primarySlot = 0;
    this.subSlot.fill(0);
    this.cart.resetBanks();   // /RESET reaches the cartridge (SRAM keeps its contents)
    this.rebuild();
  }

  // ── Snapshot state ───────────────────────────────────────────────────────

  /** The RAM, the slot and sub-slot registers and the cartridge in slot 1:
   *  its image, mapper and the 8KB ROM bank each segment shows (-1 = none).
   *  The bank registers, SRAM and SCC follow in the cartridge's own
   *  extension ({@link MsxCartridge.saveExtra}), which the machine appends
   *  to the same section. The internal and firmware ROMs are not state. */
  saveState(w: StateWriter): void {
    w.raw(this.ram);
    w.u8(this.primarySlot);
    w.raw(this.subSlot);
    const cart = this.cart.rom;
    w.bool(cart !== null);
    if (!cart) return;
    w.bytes(cart);
    w.str(this.cart.mapper);
    for (let seg = 0; seg < SEGS; seg++) w.i32(this.cart.blockIndex(seg));
  }

  /** Restore what {@link saveState} wrote, cartridge included (inserted
   *  without the power-cycle a user insert makes). */
  loadState(r: StateReader): void {
    r.rawInto(this.ram);
    this.primarySlot = r.u8();
    r.rawInto(this.subSlot);
    if (r.bool()) {
      const image = r.bytes(1 << 23);
      const mapper = r.str();
      if (!isMsxMapper(mapper)) throw new Error(`Snapshot cartridge mapper ${mapper} is not supported`);
      this.cart.insert(image, mapper);
      const banks: number[] = [];
      for (let seg = 0; seg < SEGS; seg++) banks.push(r.i32());
      this.cart.applyBlockIndices(banks);
    } else {
      this.cart.insert(null, 'plain');
    }
    this.rebuild();
  }
}
