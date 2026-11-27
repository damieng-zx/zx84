/**
 * Jupiter Ace on-demand inspection: the memory map, whose RAM-pack row follows
 * the fitted pack.
 */

import type { MachineInspection, MemoryMapSnapshot, MemoryMapSlot } from '@/machines/machine.ts';
import type { JupiterAceMachine } from '../ace-machine.ts';

function aceMemoryMap(m: JupiterAceMachine): MemoryMapSnapshot | null {
  const pack = m.memory.ramPackKB;
  const slots: MemoryMapSlot[] = [
    { range: '0000-1FFF', read: 'FORTH ROM' },
    { range: '2000-27FF', read: 'Video RAM', flags: ['screen'] },
    { range: '2800-2FFF', read: 'Char RAM' },
    { range: '3000-3FFF', read: 'Main RAM' },
  ];
  if (pack === 16) slots.push({ range: '4000-7FFF', read: 'RAM pack (16K)' });
  else if (pack === 48) slots.push({ range: '4000-FFFF', read: 'RAM pack (48K)' });
  else slots.push({ range: '4000-FFFF', read: '(expansion)' });
  return { slots, registers: [] };
}

export class AceInspection implements MachineInspection {
  constructor(private readonly machine: JupiterAceMachine) {}

  memoryMap() { return aceMemoryMap(this.machine); }
}
