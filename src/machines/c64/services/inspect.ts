/**
 * C64 on-demand inspection: the Memory pane's banking view and the BASIC V2
 * listing and variables.
 */

import type { MachineInspection, MemoryMapSnapshot } from '@/machines/machine.ts';
import { parseC64Basic, parseC64BasicVariables } from '@/basic/c64-basic-parser.ts';
import { hex8 } from '@/utils/hex.ts';
import type { C64Machine } from '../c64-machine.ts';
import { C64_CART_TYPE_NAMES } from '../cartridge.ts';

function c64MemoryMap(m: C64Machine): MemoryMapSnapshot {
  const mem = m.memory;
  const vicBank = mem.vicBase >> 14;
  const screen = mem.vicBase | ((m.vic.regs[0x18] & 0xF0) << 6);
  const cart = mem.cart;
  const slots = [
    { range: 'E000-FFFF', read: mem.romhE ? 'Cartridge ROMH' : mem.kernalIn ? 'KERNAL ROM' : 'RAM' },
    { range: 'D000-DFFF', read: mem.ioIn ? 'I/O' : mem.charIn ? 'Character ROM' : 'RAM' },
    { range: 'C000-CFFF', read: mem.ultimax ? 'Open' : 'RAM' },
    { range: 'A000-BFFF', read: mem.romhA ? 'Cartridge ROMH' : mem.ultimax ? 'Open' : mem.basicIn ? 'BASIC ROM' : 'RAM' },
  ];
  if (cart) {
    slots.push({ range: '8000-9FFF', read: mem.romlIn ? 'Cartridge ROML' : 'RAM' });
    slots.push({ range: '1000-7FFF', read: mem.ultimax ? 'Open' : 'RAM' });
    slots.push({ range: '0000-0FFF', read: 'RAM' });
  } else {
    slots.push({ range: '0000-9FFF', read: 'RAM' });
  }
  const registers = [
    { name: '6510 port', value: `$${hex8(mem.portData)} (DDR $${hex8(mem.portDdr)})` },
    { name: 'VIC bank', value: `${vicBank} ($${hex8(vicBank << 6)}00)` },
    { name: 'Screen', value: `$${screen.toString(16).toUpperCase().padStart(4, '0')}` },
    { name: 'Cassette', value: mem.motorOn ? 'motor on' : 'motor off' },
  ];
  if (cart) {
    const { exrom, game } = cart.lines;
    registers.push({ name: 'Cartridge', value: `${C64_CART_TYPE_NAMES[cart.type]}, EXROM ${exrom} GAME ${game}${mem.ultimax ? ' (Ultimax)' : ''}` });
  }
  return { slots, registers };
}

export class C64Inspection implements MachineInspection {
  constructor(private readonly m: C64Machine) {}

  memoryMap() { return c64MemoryMap(this.m); }

  // BASIC V2 keeps its program and variable tables in the 64K of RAM.
  basicListing() { return parseC64Basic(this.m.memory.ram); }

  basicVars() { return parseC64BasicVariables(this.m.memory.ram); }
}
