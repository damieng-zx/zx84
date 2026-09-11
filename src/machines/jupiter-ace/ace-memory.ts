/**
 * AceMemory — Jupiter Ace memory decoding.
 *
 * The whole 16KB block at 0x2000-0x3FFF decodes with just three address lines
 * (A13 unasserted selects the block; A11/A12 pick the chip), which is why the
 * three 1KB chips mirror through their unconnected upper address bits (MAME
 * cantab/jupace.cpp address_map, jupiter-ace.co.uk programmer's memory map):
 *
 *   2000-27FF  video RAM   (1KB chip, A10 floating → mirrors at 2000-23FF)
 *              2400-26FF screen file; 2700 always reads 0 (ULA tie-off);
 *              2701-27FF the 254-byte PAD RAM
 *   2800-2FFF  char RAM   (1KB chip, A10 floating → mirrors at 2800-2BFF)
 *   3000-3FFF  main RAM   (1KB chip, A10/A11 floating → mirrors 3000-3BFF)
 *   4000-FFFF  RAM pack: 0x4000-0x7FFF with the 16K pack (19K total),
 *              0x4000-0xFFFF with the 48K pack (51K total); open bus when
 *              no pack is fitted
 *
 * The 8KB ROM occupies 0x0000-0x1FFF with no mirror. Write dispatch mirrors
 * read dispatch exactly (ROM and open bus silently drop writes).
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import { ACE_ROM_SIZE } from './constants.ts';

/** 1KB per chip; the offset inside a chip is always addr & 0x3FF. */
const CHIP_MASK = 0x03FF;

/** RAM pack sizes, in KB. 0 = no pack fitted (stock 3K machine). */
export type AceRamPackKB = 0 | 16 | 48;

export class AceMemory implements IMachineMemory {
  private rom = new Uint8Array(ACE_ROM_SIZE);
  private readonly vram = new Uint8Array(0x400);
  private readonly charRam = new Uint8Array(0x400);
  private readonly ram = new Uint8Array(0x400);
  /** Expansion RAM at 0x4000 (null = no pack → open bus above 0x3FFF). */
  private expansion: Uint8Array | null = null;

  /** Fit a RAM pack: 16K maps 0x4000-0x7FFF, 48K maps 0x4000-0xFFFF,
   *  0 removes any pack. The FORTH ROM probes the pack at boot and moves
   *  RAMTOP up by itself — no further coaxing needed. */
  setRamPack(kb: AceRamPackKB): void {
    this.expansion = kb > 0 ? new Uint8Array(kb * 1024) : null;
  }

  /** Size of the fitted RAM pack in KB (0 = none). */
  get ramPackKB(): AceRamPackKB {
    return this.expansion === null ? 0 : (this.expansion.length / 1024) as AceRamPackKB;
  }

  /** Live view of the expansion RAM, or null when no pack is fitted. */
  getRamPack(): Uint8Array | null { return this.expansion; }

  /** Install the system ROM. An 8KB image maps 1:1; a 4KB dump (one chip)
   *  is mirrored into the second 4KB, as on the real board's empty socket. */
  loadROM(data: Uint8Array): void {
    const rom = new Uint8Array(ACE_ROM_SIZE);
    if (data.length >= ACE_ROM_SIZE) {
      rom.set(data.subarray(0, ACE_ROM_SIZE));
    } else {
      const half = Math.min(data.length, ACE_ROM_SIZE / 2);
      rom.set(data.subarray(0, half));
      rom.set(rom.subarray(0, half), ACE_ROM_SIZE / 2);
    }
    this.rom = rom;
  }

  /** Live 8KB ROM view (debug / memory pane). */
  getRom(): Uint8Array { return this.rom; }

  /** Live 1KB screen file view (0x2400-0x26FF linear, 32×24 char codes). */
  getVram(): Uint8Array { return this.vram; }

  /** Live 1KB character-generator view (128 glyphs × 8 rows). */
  getCharRam(): Uint8Array { return this.charRam; }

  /** Combined RAM image (video RAM, char RAM, main RAM, then the RAM pack
   *  when fitted) for the RAM dump. */
  ramSnapshot(): Uint8Array {
    const pack = this.expansion;
    const out = new Uint8Array(0xC00 + (pack?.length ?? 0));
    out.set(this.vram, 0);
    out.set(this.charRam, 0x400);
    out.set(this.ram, 0x800);
    if (pack) out.set(pack, 0xC00);
    return out;
  }

  // ── IMachineMemory ───────────────────────────────────────────────────────

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr >= 0x4000) {
      const pack = this.expansion;
      const off = addr - 0x4000;
      return pack !== null && off < pack.length ? pack[off] : 0xFF;  // RAM pack / open bus
    }
    if (addr < 0x2000) return this.rom[addr];
    const idx = (addr >> 11) & 3;              // A11/A12 pick the chip
    const off = addr & CHIP_MASK;
    if (idx === 0) return off === 0x300 ? 0 : this.vram[off];  // 0x2700 tie-off
    if (idx === 1) return this.charRam[off];   // 2800-2FFF
    return this.ram[off];                      // 3000-3FFF
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    if (addr >= 0x4000) {
      const pack = this.expansion;
      const off = addr - 0x4000;
      if (pack !== null && off < pack.length) pack[off] = val & 0xFF;
      return;                                  // open bus: drop
    }
    if (addr < 0x2000) return;                 // ROM: drop
    const idx = (addr >> 11) & 3;
    const off = addr & CHIP_MASK;
    const v = val & 0xFF;
    if (idx === 0) this.vram[off] = v;
    else if (idx === 1) this.charRam[off] = v;
    else this.ram[off] = v;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte((addr + i) & 0xFFFF);
    return out;
  }

  /** Fresh 64KB copy of the decoded address space (debug/snapshot). */
  snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    for (let i = 0; i < 0x10000; i++) out[i] = this.readByte(i);
    return out;
  }

  /** One bank: the Ace's unpaged RAM is the 1KB main-RAM chip (the FORTH
   *  workspace); video/char RAM are reachable through the memory regions. */
  getRamBank(_n: number): Uint8Array {
    return this.ram;
  }

  readonly ramBankCount = 1;

  reset(): void {
    this.vram.fill(0);
    this.charRam.fill(0);
    this.ram.fill(0);
    this.expansion?.fill(0);
  }
}
