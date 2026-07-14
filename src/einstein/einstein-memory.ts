/**
 * EinsteinMemory — Tatung Einstein paged memory.
 *
 * From the MAME driver: the low 32KB (0x0000–0x7FFF) reads through "bank1"
 * (toggling ROM ↔ RAM) and writes through "bank2" (always RAM); 0x8000–0xFFFF
 * is plain RAM. So CPU stores into 0x0000–0x7FFF always land in the underlying
 * 64KB RAM even while the MOS ROM is mapped for reads.
 *
 * The 8KB MOS ROM is mirror-loaded across 0x0000–0x3FFF (it appears twice); the
 * upper half of the ROM window, 0x4000–0x7FFF, reads 0xFF. When the ROM is
 * paged out (port 0x24 toggle) the whole 0x0000–0x7FFF window reads RAM.
 *
 * VRAM is NOT part of this map: the 16KB video RAM lives inside the TMS9929A and
 * the CPU only reaches it through the VDP's I/O ports (0x08/0x09).
 */

import type { IMachineMemory } from '@/machine.ts';

const RAM_SIZE = 0x10000;      // 64KB
const MOS_SIZE = 0x2000;       // 8KB MOS ROM
const ROM_WINDOW = 0x8000;     // low 32KB ROM read-window when paged in

export class EinsteinMemory implements IMachineMemory {
  /** The full 64KB RAM — the write target for every address, and the read
   *  source wherever the ROM overlay is not active. */
  private readonly ram = new Uint8Array(RAM_SIZE);

  /** The 32KB ROM read-window: MOS mirrored across 0x0000–0x3FFF, 0xFF above. */
  private romWindow = new Uint8Array(ROM_WINDOW).fill(0xFF);

  /** Raw 8KB MOS image, kept for the debug/memory viewer. */
  private mos = new Uint8Array(MOS_SIZE);

  /** ROM overlay enabled (true at reset — the machine boots into the MOS). */
  private romEnabled = true;

  /** Install the MOS ROM image (clamped to 8KB) and rebuild the mirror window. */
  loadROM(data: Uint8Array): void {
    this.mos = new Uint8Array(MOS_SIZE);
    this.mos.set(data.subarray(0, MOS_SIZE));
    this.romWindow = new Uint8Array(ROM_WINDOW).fill(0xFF);
    this.romWindow.set(this.mos, 0x0000);       // 0x0000–0x1FFF
    this.romWindow.set(this.mos, 0x2000);       // 0x2000–0x3FFF (mirror)
  }

  /** Port 0x24 is a toggle: any access flips the ROM overlay in/out. */
  toggleRom(): void { this.romEnabled = !this.romEnabled; }
  get romPagedIn(): boolean { return this.romEnabled; }

  /** Live 8KB view of the MOS ROM, for the debug/memory viewer. */
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

  reset(): void {
    this.ram.fill(0);
    this.romEnabled = true;
  }
}
