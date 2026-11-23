/**
 * Einstein on-demand inspection: the memory-layout pane and the Xtal BASIC
 * listing (the program's text lives in main RAM from 0x3E01).
 */

import type { MachineInspection, MemoryMapSnapshot } from '@/machines/machine.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import { parseXtalBasic } from '@/basic/xtal-basic-parser.ts';

/**
 * Build the Einstein memory-layout snapshot. The low 32KB is a ROM read-window
 * toggled by port 0x24: when paged in the CPU reads MOS ROM (0x4000–0x7FFF
 * reads 0xFF beyond the image), but writes always fall through to the 64KB RAM
 * beneath — so each slot shows a CPU-read / CPU-write split like the CPC.
 */
function einsteinMemoryMap(m: EinsteinMachine): MemoryMapSnapshot | null {
  const mem = m.memory;
  const romIn = mem.romPagedIn;
  const romName = m.config.romSizeKB === 8 ? 'MOS ROM' : 'MOS 2.1';

  const ranges = ['C000-FFFF', '8000-BFFF', '4000-7FFF', '0000-3FFF'];
  const slots = [];
  for (let row = 0; row < 4; row++) {
    const slot = 3 - row;
    let read: string;
    if (romIn && slot === 0) read = romName;
    else if (romIn && slot === 1) read = '(0xFF)';
    else read = 'RAM';
    slots.push({ range: ranges[row], read, write: 'RAM' });
  }

  const registers = [
    { name: 'ROM overlay', value: romIn ? 'paged in (port &24)' : 'paged out (port &24)' },
  ];

  return { columns: ['CPU read', 'CPU write'], slots, registers };
}

export class EinsteinInspection implements MachineInspection {
  constructor(private readonly m: EinsteinMachine) {}

  memoryMap() { return einsteinMemoryMap(this.m); }

  // Xtal BASIC's program text lives in main RAM under any ROM overlay, so we
  // read the underlying RAM (not the paged address space).
  basicListing() { return parseXtalBasic(this.m.memory.ramSnapshot()); }
}
