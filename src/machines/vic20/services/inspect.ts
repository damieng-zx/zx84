/**
 * VIC-20 on-demand inspection: the memory-layout pane and BASIC V2.
 */

import type { MachineInspection, MemoryMapSnapshot } from '@/machines/machine.ts';
import { parseC64Basic, parseC64BasicVariables } from '@/basic/c64-basic-parser.ts';
import { hex16 } from '@/utils/hex.ts';
import type { Vic20Machine } from '../vic20-machine.ts';

function vic20MemoryMap(m: Vic20Machine): MemoryMapSnapshot {
  const e = m.memory.expansion;
  const cart = m.memory.cart;
  // Cartridge ROM answers ahead of any RAM in its block.
  const block = (n: 1 | 2 | 3 | 5, on: boolean): string =>
    (cart?.blocks.has(n) ? 'Cartridge ROM' : on ? 'RAM (expansion)' : 'Empty');
  const ram = (on: boolean): string => (on ? 'RAM (expansion)' : 'Empty');
  const cpuAddr = (vicAddr: number): number => ((vicAddr & 0x2000) === 0 ? 0x8000 : 0) | (vicAddr & 0x1FFF);
  return {
    slots: [
      { range: 'E000-FFFF', read: 'KERNAL ROM' },
      { range: 'C000-DFFF', read: 'BASIC ROM' },
      { range: 'A000-BFFF', read: block(5, e.blk5) },
      { range: '9800-9FFF', read: 'I/O 2-3 (expansion port)' },
      { range: '9400-97FF', read: 'Colour RAM' },
      { range: '9000-93FF', read: 'VIC, VIA 1, VIA 2' },
      { range: '8000-8FFF', read: 'Character ROM' },
      { range: '6000-7FFF', read: block(3, e.blk3) },
      { range: '4000-5FFF', read: block(2, e.blk2) },
      { range: '2000-3FFF', read: block(1, e.blk1) },
      { range: '1000-1FFF', read: 'RAM', flags: ['screen'] },
      { range: '0400-0FFF', read: ram(e.ram123) },
      { range: '0000-03FF', read: 'RAM' },
    ],
    registers: [
      { name: 'Screen', value: `$${hex16(cpuAddr(m.vic.screenAddress))}` },
      { name: 'Characters', value: `$${hex16(cpuAddr(m.vic.charAddress))}` },
      { name: 'Colour', value: `$${hex16(0x9400 | (m.vic.screenAddress & 0x3FF))}` },
    ],
  };
}

export class Vic20Inspection implements MachineInspection {
  constructor(private readonly m: Vic20Machine) {}

  memoryMap() { return vic20MemoryMap(this.m); }

  // BASIC V2 keeps its program and variable pointers where the C64's does.
  basicListing() { return parseC64Basic(this.m.memory.ram); }

  basicVars() { return parseC64BasicVariables(this.m.memory.ram); }
}
