/**
 * Memotech MTX on-demand inspection: the memory-layout pane and the BASIC
 * listing (the program sits at CPU 0x4000).
 *
 * Separate from the frame probe because these are asked for on demand and may
 * allocate, while `sample()` runs every rAF and must not.
 */

import type { MachineInspection, MemoryMapSnapshot } from '@/machines/machine.ts';
import { parseMtxBasic } from '@/basic/mtx-basic-parser.ts';
import { hex8 } from '@/utils/hex.ts';
import type { MtxMachine } from '../mtx-machine.ts';

/** Friendly name for an MTX switchable ROM page index. Pages 2,3,6,7 are
 *  normally empty (0xFF); page 2 is the ROM-pack (cartridge) slot. */
function mtxRomPageName(page: number, hasCart: boolean): string {
  if (page === 0) return 'BASIC ROM';
  if (page === 1) return 'Assembler ROM';
  if (page === 4) return 'CP/M ROM';
  if (page === 5) return 'FDX ROM';
  if (page === 2 && hasCart) return 'Cartridge';
  return `(empty ${page})`;
}

/** Build the MTX memory-layout snapshot.
 *
 *  The MTX address space is unlike the Spectrum/CPC 4×16KB grid: an 8K OS ROM
 *  at 0x0000, an 8K switchable ROM page at 0x2000, paged RAM 0x4000-0xBFFF, and
 *  a common 16K RAM block at 0xC000. In CP/M (all-RAM) mode the ROMs are
 *  replaced by RAM throughout. */
function mtxMemoryMap(m: MtxMachine): MemoryMapSnapshot | null {
  const mem = m.memory;
  const ramMode = mem.ramMode;
  const romPage = mem.selectedRomPage;
  const hasCart = mem.romPackSizeBytes > 0;

  const slots = [
    {
      range: 'C000-FFFF',
      read: 'RAM (common)',
    },
    {
      range: '4000-BFFF',
      read: `RAM page ${mem.selectedRamPage}`,
    },
    {
      range: '2000-3FFF',
      read: ramMode ? 'RAM' : mtxRomPageName(romPage, hasCart),
    },
    {
      range: '0000-1FFF',
      read: ramMode ? 'RAM' : 'OS ROM',
    },
  ];

  const ramKb = Math.round(mem.ramSizeBytes / 1024);
  const registers = [
    { name: 'IOBYTE', value: hex8(mem.pageRegister) },
    { name: 'ROM page', value: String(romPage) },
    { name: 'RAM page', value: String(mem.selectedRamPage) },
    { name: 'Mode', value: ramMode ? 'CP/M (all-RAM)' : 'ROM' },
    { name: 'RAM', value: `${ramKb}K${mem.ramExpansion512kEnabled ? ' +512K' : ''}` },
  ];

  return { slots, registers };
}

export class MtxInspection implements MachineInspection {
  constructor(private readonly machine: MtxMachine) {}

  memoryMap() { return mtxMemoryMap(this.machine); }

  // The BASIC program sits at CPU 0x4000; snapshot() gives the flat CPU view.
  basicListing() { return parseMtxBasic(this.machine.memory.snapshot()); }
}
