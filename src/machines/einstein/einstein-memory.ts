/**
 * EinsteinMemory — Tatung Einstein paged memory.
 *
 * From the MAME driver: the low 32KB (0x0000–0x7FFF) reads through "bank1"
 * (toggling ROM ↔ RAM) and writes through "bank2" (always RAM); 0x8000–0xFFFF
 * is plain RAM. So CPU stores into 0x0000–0x7FFF always land in the underlying
 * 64KB RAM even while the MOS ROM is mapped for reads.
 *
 * The ROM window layout is model-dependent (config.ts):
 *  - TC-01: the 8KB MOS is mirror-loaded across 0x0000–0x3FFF.
 *  - Einstein 256: the 16KB MOS 2.1 sits at 0x0000–0x3FFF with no mirror.
 * In both cases the upper half of the ROM window, 0x4000–0x7FFF, reads 0xFF.
 * When the ROM is paged out (port 0x24 toggle) the whole 0x0000–0x7FFF window
 * reads RAM.
 *
 * VRAM is NOT part of this map: the video RAM lives inside the VDP and the
 * CPU only reaches it through the VDP's I/O ports.
 */

import type { IMachineMemory } from '@/machines/machine.ts';

const RAM_SIZE = 0x10000;      // 64KB
const ROM_WINDOW = 0x8000;     // low 32KB ROM read-window when paged in

export interface EinsteinMemoryOptions {
  /** MOS ROM size in bytes (0x2000 TC-01, 0x4000 Einstein 256). */
  readonly romSize: number;
  /** TC-01: mirror the 8KB MOS across 0x0000–0x3FFF. */
  readonly romMirrored: boolean;
}

export class EinsteinMemory implements IMachineMemory {
  private readonly options: EinsteinMemoryOptions;

  /** The full 64KB RAM — the write target for every address, and the read
   *  source wherever the ROM overlay is not active. */
  private readonly ram = new Uint8Array(RAM_SIZE);

  /** The 32KB ROM read-window, 0xFF-filled beyond the MOS image. */
  private romWindow = new Uint8Array(ROM_WINDOW).fill(0xFF);

  /** Raw MOS image, kept for the debug/memory viewer. */
  private mos = new Uint8Array(0);

  /** ROM overlay enabled (true at reset — the machine boots into the MOS). */
  private romEnabled = true;

  constructor(options: EinsteinMemoryOptions = { romSize: 0x2000, romMirrored: true }) {
    this.options = options;
    this.mos = new Uint8Array(options.romSize);
  }

  /** Install the MOS ROM image (clamped to the model's ROM size) and rebuild
   *  the read window (mirrored on the TC-01, linear on the 256). */
  loadROM(data: Uint8Array): void {
    const { romSize, romMirrored } = this.options;
    this.mos = new Uint8Array(romSize);
    this.mos.set(data.subarray(0, romSize));
    this.romWindow = new Uint8Array(ROM_WINDOW).fill(0xFF);
    this.romWindow.set(this.mos, 0x0000);                       // 0x0000+
    if (romMirrored) this.romWindow.set(this.mos, romSize);     // TC-01 mirror
  }

  /** Port 0x24 is a toggle: any access flips the ROM overlay in/out. */
  toggleRom(): void { this.romEnabled = !this.romEnabled; }
  get romPagedIn(): boolean { return this.romEnabled; }

  /** Live view of the MOS ROM, for the debug/memory viewer. */
  getRom(): Uint8Array { return this.mos; }

  // ── IMachineMemory ───────────────────────────────────────────────────────

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (this.romEnabled && addr < ROM_WINDOW) return this.romWindow[addr];
    return this.ram[addr];
  }

  writeByte(addr: number, val: number): void {
    // Writes always land in RAM (bank2 never switches away from RAM).
    this.ram[addr & 0xFFFF] = val & 0xFF;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte((addr + i) & 0xFFFF);
    return out;
  }

  /** Fresh 64KB copy of the current paged address space (debug/snapshot). */
  snapshot(): Uint8Array {
    const out = this.ram.slice();
    if (this.romEnabled) out.set(this.romWindow, 0);
    return out;
  }

  /** Fresh 64KB copy of the underlying RAM, ignoring the ROM overlay — where
   *  a loaded program keeps its code/data. */
  ramSnapshot(): Uint8Array {
    return this.ram.slice();
  }

  getRamBank(n: number): Uint8Array {
    const base = (n & 3) * 0x4000;
    return this.ram.subarray(base, base + 0x4000);
  }

  /** A flat 64K of RAM, presented as four 16K banks. */
  readonly ramBankCount = 4;

  reset(): void {
    this.ram.fill(0);
    this.romEnabled = true;
  }
}
