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

import type { IMachineMemory } from '@/machine.ts';
import type { CpcConfig } from '@/cpc/config.ts';

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

  /** Lower ROM (OS), overlays slot 0 when enabled. */
  private lowerRom = new Uint8Array(SLOT_SIZE);
  /** Upper ROM slots (0 = BASIC, 7 = AMSDOS). Sparse; an absent slot reads as
   *  no-ROM (0xFF) so the firmware's boot-time ROM scan skips it. */
  private readonly upperRoms: (Uint8Array | undefined)[] = [];
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

  private readonly ramBanks: number;

  constructor(cfg: CpcConfig) {
    this.ramBanks = cfg.ramBanks;
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
    if (this.lowerRomEnabled) this.readPtr[0] = this.lowerRom;
    if (this.upperRomEnabled) {
      this.readPtr[3] = this.upperRoms[this.selectedUpperRom] ?? this.absentRom;
    }
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

  getRamBank(n: number): Uint8Array {
    return this.ram[n] ?? this.ram[0];
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
    this.applyMapping();
  }
}

/** Copy a ROM image into a fresh exactly-16KB buffer (pads or clamps). */
function padTo16K(src: Uint8Array) {
  const out = new Uint8Array(SLOT_SIZE);
  out.set(src.subarray(0, SLOT_SIZE));
  return out;
}
