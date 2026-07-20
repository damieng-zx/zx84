/**
 * CpcMemory — Amstrad CPC paged memory.
 *
 * Unlike the Spectrum's single flat 64KB view, the CPC overlays ROM on RAM in
 * two places at once and CPU writes always fall through ROM to the RAM beneath.
 * That maps naturally onto per-slot read/write pointers:
 *
 *   read8(addr)        = readPtr[addr >> 14][addr & 0x3FFF]   (ROM or RAM)
 *   write8(addr, val)  = writePtr[addr >> 14][addr & 0x3FFF]  (always RAM)
 *
 *   - Lower ROM (OS)    overlays slot 0 (0x0000–0x3FFF) when enabled.
 *   - Upper ROM (BASIC / AMSDOS / …) overlays slot 3 (0xC000–0xFFFF) when
 *     enabled; the active upper ROM is chosen by OUT &DFxx.
 *   - RAM banking (6128) remaps the four 16KB slots to physical banks via the
 *     Gate-Array %11xxxxxx command on port &7Fxx.
 *
 * The Gate Array reads display bytes straight from RAM (DMA) and never sees the
 * ROM overlays — `videoBank()` exposes the RAM bank for the video fetch.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import type { CpcConfig } from '@/machines/cpc/config.ts';

const SLOT_SIZE = 0x4000; // 16KB

/**
 * The eight standard 6128 RAM-bank configurations selected by the low 3 bits of
 * the Gate-Array %11xxxxxx command. Each entry lists the physical bank mapped
 * into Z80 slots 0–3. Banks 0–3 are the base 64KB; 4–7 are the expansion 64KB.
 * (Dk'tronics-compatible layout, as the 6128 PAL implements it.)
 */
const RAM_CONFIGS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 2, 3],
  [0, 1, 2, 7],
  [4, 5, 6, 7],
  [0, 3, 2, 7],
  [0, 4, 2, 3],
  [0, 5, 2, 3],
  [0, 6, 2, 3],
  [0, 7, 2, 3],
];

export class CpcMemory implements IMachineMemory {
  /** Physical 16KB RAM banks (8 on the 6128). */
  private readonly ram: Uint8Array[];

  /** Lower ROM (OS), overlays the slot chosen by `lowerRomSlot` when enabled. */
  private lowerRom: Uint8Array = new Uint8Array(SLOT_SIZE);
  /** Upper ROM slots (0 = BASIC, 7 = AMSDOS). Sparse; an absent slot reads as
   *  no-ROM (0xFF) so the firmware's boot-time ROM scan skips it. */
  private readonly upperRoms: (Uint8Array | undefined)[] = [];

  /** All 32 cartridge ROM pages (Plus), retained so the ASIC's RMR2 register can
   *  bank any of the low 8 pages into the lower-ROM slot. Empty on non-Plus. */
  private readonly cartPages: (Uint8Array | undefined)[] = [];
  /** Which cartridge page currently backs the lower ROM (Plus RMR2 D2–D0). */
  private lowerRomPage = 0;
  /** Which Z80 slot the lower ROM overlays: 0 = &0000, 1 = &4000, 2 = &8000
   *  (Plus RMR2 D4–D3). 0 on the classic CPC. */
  private lowerRomSlot = 0;
  /** Returned for an enabled-but-absent upper ROM (open bus). */
  private readonly absentRom = new Uint8Array(SLOT_SIZE).fill(0xFF);

  /** Per-slot read source (ROM overlay or RAM bank). */
  private readonly readPtr: Uint8Array[] = new Array(4);
  /** Per-slot write target (always the RAM bank — writes fall through ROM). */
  private readonly writePtr: Uint8Array[] = new Array(4);

  /** Which physical bank backs each slot (for getRamBank/video). */
  private readonly slotBank = new Int8Array(4);

  private ramConfig = 0;       // low 3 bits of the %11xxxxxx command
  private ram64kBlock = 0;     // bits 5-3 (64KB page; >128K only)
  private lowerRomEnabled = true;
  private upperRomEnabled = true;
  private selectedUpperRom = 0;

  /** Multiface Two slot-0 overlay (16KB) when paged in; null otherwise. Takes
   *  precedence over the normal slot-0 read/write source. */
  private mfOverlay: Uint8Array | null = null;

  /**
   * Plus ASIC register window (16 KB) when paged into slot 1 by RMR2; null
   * when hidden. Takes precedence over the normal slot-1 RAM mapping for both
   * reads and writes — the ASIC's own decode handles side-effects via the
   * `cpuWrite` indirection in `cpc-io.ts`. The Multiface overlay only touches
   * slot 0, so the two never conflict.
   */
  private asicPage: Uint8Array | null = null;

  private readonly ramBanks: number;
  /** Cached at construction — drives the Plus ROM-select logical-to-physical
   *  translation in `selectUpperRom`. */
  private readonly isPlus: boolean;

  constructor(cfg: CpcConfig) {
    this.ramBanks = cfg.ramBanks;
    this.isPlus = cfg.isPlus;
    this.ram = [];
    for (let i = 0; i < cfg.ramBanks; i++) this.ram.push(new Uint8Array(SLOT_SIZE));
    this.applyMapping();
  }

  // ── ROM loading ────────────────────────────────────────────────────────

  /** Install the three CPC ROM images explicitly. */
  loadRoms(lowerOs: Uint8Array, basic: Uint8Array, amsdos?: Uint8Array): void {
    this.lowerRom = padTo16K(lowerOs);
    this.upperRoms[0] = padTo16K(basic);
    if (amsdos) this.upperRoms[7] = padTo16K(amsdos);
    // The Plus's ROM-select byte translates logical 0 → physical 1 (BASIC)
    // and logical 7 → physical 3 (AMSDOS), matching the Burnin' Rubber
    // cartridge layout. Mirror the loaded ROMs into those physical slots so
    // firmware ROM-scans resolve cleanly. A real .CPR overrides these via
    // `loadCartridge`, which clears every upper slot first.
    if (this.isPlus) {
      this.upperRoms[1] = this.upperRoms[0];
      if (amsdos) this.upperRoms[3] = this.upperRoms[7];
    }
    this.applyMapping();
  }

  /**
   * Load a parsed .CPR cartridge image.
   *
   * Two cases:
   *
   *   1. **System cartridge** (page 0 present, e.g. Burnin' Rubber): replaces
   *      the lower (OS) ROM with page 0 and CLEARS every upper-ROM slot
   *      first, so any stale stand-in firmware (the V3 mirror populated by
   *      `loadRoms`) is gone — absent cartridge pages correctly read as 0xFF
   *      (open bus), matching real Plus hardware.
   *
   *   2. **Game-only cartridge** (no page 0): leaves the existing lower ROM
   *      and upper-ROM slots intact, overlaying only the pages the cartridge
   *      provides. The running firmware (typically the V3 stand-in) supplies
   *      BASIC/AMSDOS; the cartridge adds the game at pages 4..7.
   */
  loadCartridge(pages: ReadonlyArray<Uint8Array | undefined>): void {
    const page0 = pages[0];
    if (page0) {
      // System cartridge — clear stale state so only cartridge pages remain.
      this.lowerRom = padTo16K(page0);
      for (let i = 0; i < this.upperRoms.length; i++) this.upperRoms[i] = undefined;
    }
    for (let i = 1; i < 32; i++) {
      const p = pages[i];
      if (p) this.upperRoms[i] = padTo16K(p);
    }
    // Retain every page for RMR2 lower-ROM banking (D2–D0 selects one of the
    // low 8 pages into the lower-ROM slot). Page 0 boots as the lower ROM.
    this.cartPages.length = 0;
    for (let i = 0; i < 32; i++) this.cartPages[i] = pages[i] ? padTo16K(pages[i]!) : undefined;
    this.lowerRomPage = 0;
    this.lowerRomSlot = 0;
    // Default the selected upper ROM to physical 1 (BASIC) on Plus — the
    // Burnin' Rubber layout. selectUpperRom's logical→physical translation
    // will re-resolve on the next OUT &DFxx.
    this.selectedUpperRom = this.isPlus ? 1 : 0;
    this.applyMapping();
  }

  /**
   * Plus ASIC RMR2 lower-ROM bank select. `page` (0–7) chooses which cartridge
   * ROM page backs the lower ROM; `slot` (0 = &0000, 1 = &4000, 2 = &8000) is
   * where it overlays, from RMR2 D4–D3. Driven by the ASIC once unlocked.
   */
  setLowerRomBank(page: number, slot: number): void {
    const pg = page & 0x07;
    const sl = slot & 0x03;
    if (pg === this.lowerRomPage && sl === this.lowerRomSlot) return;
    this.lowerRomPage = pg;
    this.lowerRomSlot = sl;
    this.lowerRom = this.cartPages[pg] ?? this.absentRom;
    this.applyMapping();
  }

  /** Eject the cartridge: clear every page slot populated by `loadCartridge`. */
  ejectCartridge(): void {
    for (let i = 0; i < 32; i++) this.upperRoms[i] = undefined;
    this.selectedUpperRom = this.isPlus ? 1 : 0;
    this.applyMapping();
  }

  /** Install or replace a single upper ROM image at slot `n` (0 = BASIC,
   *  7 = AMSDOS). Used to overlay ParaDOS over AMSDOS at slot 7. */
  setUpperRom(n: number, data: Uint8Array): void {
    this.upperRoms[n] = padTo16K(data);
    this.applyMapping();
  }

  /**
   * Machine-interface ROM load. Splits a combined image:
   *   32KB → OS (lower) + BASIC (upper 0)
   *   48KB → + AMSDOS (upper 7)
   */
  loadROM(data: Uint8Array): void {
    if (data.length < 0x8000) {
      throw new Error(`CPC ROM too small: ${data.length} bytes (need >= 32KB)`);
    }
    const lower = data.subarray(0, 0x4000);
    const basic = data.subarray(0x4000, 0x8000);
    const amsdos = data.length >= 0xC000 ? data.subarray(0x8000, 0xC000) : undefined;
    this.loadRoms(lower, basic, amsdos);
  }

  // ── Bank / ROM control (driven by cpc-io) ────────────────────────────────

  setLowerRomEnabled(on: boolean): void {
    if (this.lowerRomEnabled === on) return;
    this.lowerRomEnabled = on;
    this.applyMapping();
  }

  setUpperRomEnabled(on: boolean): void {
    if (this.upperRomEnabled === on) return;
    this.upperRomEnabled = on;
    this.applyMapping();
  }

  /** OUT &DFxx — select which upper ROM appears at 0xC000 when enabled. */
  selectUpperRom(n: number): void {
    // On the Plus, the ROM-select byte carries both logical and physical IDs:
    //   bit 7 = 0 → logical (0..127); the firmware ROM scan uses 0 (BASIC)
    //            and 7 (AMSDOS), which on the Burnin' Rubber cartridge map
    //            to physical pages 1 and 3 respectively.
    //   bit 7 = 1 → direct physical (n & 0x1F), addressing any of the 32
    //            cartridge pages.
    // Non-Plus 464/664/6128 have no cartridge — pass `n` straight through.
    if (this.isPlus) {
      let physical: number;
      if (n & 0x80) physical = n & 0x1F;
      else if (n === 0) physical = 1;
      else if (n === 7) physical = 3;
      else physical = 1;
      n = physical;
    }
    if (this.selectedUpperRom === n) return;
    this.selectedUpperRom = n;
    if (this.upperRomEnabled) this.applyMapping();
  }

  /** Gate-Array %11xxxxxx command — RAM bank configuration. */
  setRamConfig(val: number): void {
    const config = val & 0x07;
    const block = (val >> 3) & 0x07;
    if (config === this.ramConfig && block === this.ram64kBlock) return;
    this.ramConfig = config;
    this.ram64kBlock = block;
    this.applyMapping();
  }

  private applyMapping(): void {
    const cfg = RAM_CONFIGS[this.ramConfig];
    for (let slot = 0; slot < 4; slot++) {
      let bank = cfg[slot];
      // Expansion banks (>=4) shift by the selected 64KB block on machines
      // with more than 128KB; the 6128 only has block 0.
      if (bank >= 4) bank += this.ram64kBlock * 4;
      if (bank >= this.ramBanks) bank %= this.ramBanks;
      this.slotBank[slot] = bank;
      this.writePtr[slot] = this.ram[bank];
      this.readPtr[slot] = this.ram[bank];
    }
    if (this.lowerRomEnabled) this.readPtr[this.lowerRomSlot] = this.lowerRom;
    if (this.upperRomEnabled) {
      this.readPtr[3] = this.upperRoms[this.selectedUpperRom] ?? this.absentRom;
    }
    // The Plus ASIC register window, when paged in by RMR2, replaces slot 1
    // for both reads and writes — CPU writes go through `cpuWrite` for
    // side-effects, but the storage underneath is this buffer.
    if (this.asicPage) {
      this.readPtr[1] = this.asicPage;
      this.writePtr[1] = this.asicPage;
    }
    // Multiface Two overlay wins slot 0 outright (ROM+RAM, read and write).
    if (this.mfOverlay) {
      this.readPtr[0] = this.mfOverlay;
      this.writePtr[0] = this.mfOverlay;
    }
  }

  // ── Multiface Two slot-0 overlay ──────────────────────────────────────────

  setSlot0Overlay(buf: Uint8Array): void {
    this.mfOverlay = buf;
    this.applyMapping();
  }

  clearSlot0Overlay(): void {
    this.mfOverlay = null;
    this.applyMapping();
  }

  // ── Plus ASIC register window ─────────────────────────────────────────────

  /**
   * Page the Plus ASIC's 16 KB register window into slot 1 (`&4000–&7FFF`) or
   * hide it again. Driven by the ASIC's RMR2 escape. Passing null restores the
   * normal RAM-backed slot 1 mapping.
   */
  setAsicPage(buf: Uint8Array | null): void {
    this.asicPage = buf;
    this.applyMapping();
  }

  // ── IMachineMemory ───────────────────────────────────────────────────────

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
    for (let slot = 0; slot < 4; slot++) out.set(this.readPtr[slot], slot * SLOT_SIZE);
    return out;
  }

  /** Fresh 64KB copy of the underlying RAM (the four mapped RAM banks), ignoring
   *  the ROM overlays — this is where BASIC keeps its program text/variables, so
   *  the BASIC viewer reads from here rather than the ROM-shadowed snapshot(). */
  ramSnapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    for (let slot = 0; slot < 4; slot++) out.set(this.writePtr[slot], slot * SLOT_SIZE);
    return out;
  }

  getRamBank(n: number): Uint8Array {
    return this.ram[n] ?? this.ram[0];
  }

  /** Lower (OS) ROM image — live 16KB view, for the debug/memory viewer. */
  getLowerRom(): Uint8Array {
    return this.lowerRom;
  }

  /** Upper ROM image by select index (0 = BASIC, 7 = AMSDOS), or undefined if
   *  no ROM occupies that slot. Live 16KB view, for the debug/memory viewer. */
  getUpperRom(n: number): Uint8Array | undefined {
    return this.upperRoms[n];
  }

  /**
   * Current paging configuration, for the memory-layout debug pane. Exposed as a
   * single snapshot (rather than per-field getters) to avoid clashing with the
   * like-named private fields. `slotBanks[s]` is the physical RAM bank that backs
   * Z80 slot `s` — the CPU *write* target and the video-DMA source — regardless
   * of any ROM overlay reading on top of it.
   */
  pagingState(): {
    ramConfig: number;
    ram64kBlock: number;
    lowerRomEnabled: boolean;
    upperRomEnabled: boolean;
    selectedUpperRom: number;
    slotBanks: [number, number, number, number];
  } {
    return {
      ramConfig: this.ramConfig,
      ram64kBlock: this.ram64kBlock,
      lowerRomEnabled: this.lowerRomEnabled,
      upperRomEnabled: this.upperRomEnabled,
      selectedUpperRom: this.selectedUpperRom,
      slotBanks: [this.slotBank[0], this.slotBank[1], this.slotBank[2], this.slotBank[3]],
    };
  }

  /** Restore the full paging configuration from a snapshot in one shot, then
   *  remap. Counterpart to pagingState(); used by the .SNA loader. */
  restorePaging(state: {
    ramConfig: number;
    ram64kBlock: number;
    lowerRomEnabled: boolean;
    upperRomEnabled: boolean;
    selectedUpperRom: number;
  }): void {
    this.ramConfig = state.ramConfig & 0x07;
    this.ram64kBlock = state.ram64kBlock & 0x07;
    this.lowerRomEnabled = state.lowerRomEnabled;
    this.upperRomEnabled = state.upperRomEnabled;
    this.selectedUpperRom = state.selectedUpperRom;
    this.applyMapping();
  }

  /** RAM bank currently backing a Z80 slot (0–3), as the Gate Array's video
   *  DMA sees it — RAM only, ignoring ROM overlays. */
  videoBank(slot: number): Uint8Array {
    return this.ram[this.slotBank[slot & 3]];
  }

  /**
   * Gate-Array video DMA read of a 16-bit address. The CRTC addresses the base
   * 64KB of RAM (banks 0–3) directly, independent of CPU ROM overlays and (for
   * standard programs) of the RAM-expansion banking.
   */
  readVideo(addr: number): number {
    return this.ram[(addr >>> 14) & 3][addr & 0x3FFF];
  }

  reset(): void {
    this.ramConfig = 0;
    this.ram64kBlock = 0;
    this.lowerRomEnabled = true;
    this.upperRomEnabled = true;
    this.selectedUpperRom = 0;
    this.mfOverlay = null;
    this.asicPage = null;
    // Restore the default lower-ROM bank (cartridge page 0 at &0000) on the Plus.
    this.lowerRomPage = 0;
    this.lowerRomSlot = 0;
    if (this.cartPages[0]) this.lowerRom = this.cartPages[0]!;
    this.applyMapping();
  }
}

/** Copy a ROM image into a fresh exactly-16KB buffer (pads or clamps). */
function padTo16K(src: Uint8Array) {
  const out = new Uint8Array(SLOT_SIZE);
  out.set(src.subarray(0, SLOT_SIZE));
  return out;
}
