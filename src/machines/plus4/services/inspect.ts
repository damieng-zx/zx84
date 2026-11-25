/**
 * Plus/4 on-demand inspection: the Memory pane's banking view and the BASIC 3.5
 * listing and variables.
 */

import type { MachineInspection, MemoryMapSnapshot } from '@/machines/machine.ts';
import { parsePlus4Basic, parsePlus4BasicVariables } from '@/basic/plus4-basic-parser.ts';
import { hex16 } from '@/utils/hex.ts';
import type { Plus4Machine } from '../plus4-machine.ts';

function plus4MemoryMap(m: Plus4Machine): MemoryMapSnapshot {
  const mem = m.memory;
  const bankName = (n: number): string => {
    switch (n) {
      case 0: return 'BASIC ROM';
      case 1: return '3+1 function ROM';
      case 2: return 'Cartridge ROM';
      default: return 'Empty';
    }
  };
  const low = bankName(mem.bankSelect & 3);
  const high = bankName((mem.bankSelect >> 2) & 3);
  const ram = mem.romVisible ? `${high} / RAM` : 'RAM (ROMs banked out)';
  return {
    slots: [
      { range: 'FF40-FFFF', read: ram },
      { range: 'FF00-FF3F', read: 'TED registers' },
      { range: 'FE00-FEFF', read: 'I/O (1551)' },
      { range: 'FD00-FDFF', read: m.aciaFitted ? 'ACIA, PIO 1, PIO 2, bank select' : 'PIO 1, PIO 2, bank select' },
      { range: 'FC00-FCFF', read: 'KERNAL' },
      { range: 'C000-FBFF', read: `${high}, else RAM` },
      { range: '8000-BFFF', read: `${low}, else RAM` },
      { range: '0100-7FFF', read: 'RAM', flags: ['screen'] },
      { range: '0000-00FF', read: '7501 port, RAM' },
    ],
    registers: [
      { name: 'Matrix', value: `$${hex16(m.ted.screenAddress)}` },
      { name: 'Characters', value: `$${hex16(m.ted.charAddress)}` },
      { name: 'Colours', value: `$${hex16(m.ted.colourAddress)}` },
      { name: 'Banks', value: `low ${low}, high ${high}${m.memory.romVisible ? '' : ' (RAM mode)'}` },
    ],
  };
}

export class Plus4Inspection implements MachineInspection {
  constructor(private readonly m: Plus4Machine) {}

  memoryMap() { return plus4MemoryMap(this.m); }

  // BASIC 3.5 keeps its program and variable pointers where the 64's does.
  basicListing() { return parsePlus4Basic(this.m.memory.ram); }

  basicVars() { return parsePlus4BasicVariables(this.m.memory.ram); }
}
