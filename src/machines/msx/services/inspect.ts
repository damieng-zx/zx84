/**
 * MSX on-demand inspection: the memory-layout pane and MSX BASIC.
 *
 * Separate from the frame probe because these are asked for on demand and may
 * allocate, while `sample()` runs every rAF and must not.
 */

import type { MachineInspection, MemoryMapSnapshot } from '@/machines/machine.ts';
import { parseMsxBasic, parseMsxBasicVariables } from '@/basic/msx-basic-parser.ts';
import { hex8 } from '@/utils/hex.ts';
import type { MsxMachine } from '../msx-machine.ts';

/** Label the source paged into one MSX 16KB page given its primary slot number.
 *  slot 0 = internal ROM (BIOS+BASIC, pages 0-1 only; the HB-55 adds its Data
 *  Bank ROM in page 2), slot 1 = cartridge, slot 3 = rear expansion connector
 *  (the floppy disk interface's Disk BASIC ROM in page 1 when fitted, else
 *  empty). The on-board RAM is in slot 2 on the HX-10 and slot 0 page 3 on the
 *  HB-55 — the memory object knows which. */
function msxSlotLabel(m: MsxMachine, slot: number, page: number): { read: string } {
  const mem = m.memory;
  if (mem.ramCoversPage(slot, page)) return { read: 'RAM' };
  switch (slot) {
    case 0:
      if (page < 2) return { read: 'ROM' };
      return { read: mem.firmwareCoversPage(slot, page) ? 'Data Bank ROM' : '(empty)' };
    case 1: return { read: mem.cartCoversPage(page) ? 'Cartridge' : '(empty)' };
    case 2: return { read: '(empty)' };
    case 3: return { read: page === 1 && mem.hasDiskInterface ? 'Disk ROM' : '(empty)' };
    default: return { read: '?' };
  }
}

/** Build the MSX memory-layout snapshot: four 16KB pages each selecting one of
 *  four primary slots via the 2-bit fields of PPI port A (0xA8). */
function msxMemoryMap(m: MsxMachine): MemoryMapSnapshot | null {
  const mem = m.memory;
  const primary = mem.getPrimarySlot();
  const ranges = ['0000-3FFF', '4000-7FFF', '8000-BFFF', 'C000-FFFF'];

  const slots = ranges.map((range, page) => {
    const slot = (primary >> (page * 2)) & 3;
    const label = msxSlotLabel(m, slot, page);
    return { range, ...label };
  });

  return {
    slots,
    registers: mem.cartridgeMapper === 'plain'
      ? [{ name: 'Port A8', value: hex8(primary) }]
      : [{ name: 'Port A8', value: hex8(primary) }, { name: 'Mapper', value: mem.cartridgeMapper }],
  };
}

export class MsxInspection implements MachineInspection {
  constructor(private readonly m: MsxMachine) {}

  memoryMap() { return msxMemoryMap(this.m); }

  // MSX BASIC's program and variable tables live in the physical RAM slot.
  basicListing() { return parseMsxBasic(this.m.memory.ramSnapshot()); }

  basicVars() { return parseMsxBasicVariables(this.m.memory.ramSnapshot()); }
}
