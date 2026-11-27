/**
 * Enterprise on-demand inspection: the segment layout the Memory pane shows.
 */

import type { MachineInspection, MemoryMapSnapshot } from '@/machines/machine.ts';
import { hex8 } from '@/utils/hex.ts';
import type { EnterpriseMachine } from '../enterprise-machine.ts';
import { SEG_CARTRIDGE, SEG_EXDOS, SEG_HOSTFS } from '../constants.ts';

function segmentName(m: EnterpriseMachine, seg: number): string {
  if (seg >= m.memory.firstRamSegment) return seg >= 0xFC ? `VRAM ${hex8(seg)}` : `RAM ${hex8(seg)}`;
  if (!m.memory.segment(seg)) return `empty ${hex8(seg)}`;
  if (seg < SEG_CARTRIDGE) return `EXOS ${seg}`;
  if (seg < SEG_CARTRIDGE + 4) return `Cartridge ${seg - SEG_CARTRIDGE}`;
  if (seg === SEG_HOSTFS) return 'FILE: ROM';
  if (seg >= SEG_EXDOS && seg < SEG_EXDOS + 2) return `EXDOS ${seg - SEG_EXDOS}`;
  return `ROM ${hex8(seg)}`;
}

function memoryMap(m: EnterpriseMachine): MemoryMapSnapshot {
  const slots = [];
  for (let page = 3; page >= 0; page--) {
    const base = page * 0x4000;
    slots.push({
      range: `${hex8(base >> 8)}00-${hex8((base + 0x3FFF) >> 8)}FF`,
      read: segmentName(m, m.memory.pages[page]),
    });
  }
  const waits = ['all accesses', 'M1 only', 'none', 'none'][m.dave.waitMode];
  return {
    slots,
    registers: [
      { name: 'Wait states', value: waits },
      { name: 'LPT', value: `${hex8(m.nick.lptBase >> 8)}${hex8(m.nick.lptBase & 0xFF)}` },
      { name: 'Border', value: hex8(m.nick.border) },
    ],
  };
}

export class EnterpriseInspection implements MachineInspection {
  constructor(private readonly machine: EnterpriseMachine) {}

  memoryMap() { return memoryMap(this.machine); }
}
