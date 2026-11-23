/**
 * Commodore 128 on-demand inspection: the memory-layout pane and BASIC V7.0 in
 * C128 mode (text in RAM block 0, variables in block 1) — or the 64's BASIC V2
 * in C64 mode.
 */

import type { MachineInspection, MemoryMapSnapshot } from '@/machines/machine.ts';
import { parseC64Basic, parseC64BasicVariables } from '@/basic/c64-basic-parser.ts';
import { parseC128Basic, parseC128BasicVariables } from '@/basic/c128-basic-parser.ts';
import { hex8 } from '@/utils/hex.ts';
import type { C128Machine } from '../c128-machine.ts';
import { C64_CART_TYPE_NAMES } from '@/machines/shared/cbm/cartridge.ts';

const ROM_AT_8000 = ['BASIC high ROM', 'Internal function ROM', 'External function ROM', 'RAM'];
const ROM_AT_C000 = ['System ROM (editor, KERNAL)', 'Internal function ROM', 'External function ROM', 'RAM'];

function c128MemoryMap(m: C128Machine): MemoryMapSnapshot {
  const mem = m.memory;
  const mmu = mem.mmu;
  const vicBank = mem.vicBase >> 14;
  const screen = mem.vicBase | ((m.vic.regs[0x18] & 0xF0) << 6);
  const cr = mmu.cr;
  // In C64 mode the 8502's port bits 0-2 are the 64's PLA lines.
  const pins = mem.portPins;
  const loram = (pins & 1) !== 0, hiram = (pins & 2) !== 0;
  const cart = mem.cart;
  const { exrom, game } = cart ? cart.lines : { exrom: 1, game: 1 };
  const ultimax = mem.ultimax;
  const func = (name: string, rom: unknown): string => (rom ? `${name}: ${m.cartridgeFile || m.cartridge?.name || 'fitted'}` : `${name} (empty)`);
  const slots = m.c64Mode
    ? [
      { range: 'E000-FFFF', read: ultimax ? 'Cartridge ROMH' : hiram ? '64 KERNAL ROM' : 'RAM' },
      { range: 'D000-DFFF', read: mem.ioIn ? 'I/O' : loram || hiram ? 'Character ROM' : 'RAM' },
      { range: 'C000-CFFF', read: ultimax ? 'Open' : 'RAM' },
      {
        range: 'A000-BFFF',
        read: ultimax ? 'Open'
          : exrom === 0 && game === 0 && hiram ? 'Cartridge ROMH'
            : loram && hiram && game === 1 ? '64 BASIC ROM' : 'RAM',
      },
      { range: '8000-9FFF', read: ultimax || (exrom === 0 && loram && hiram) ? 'Cartridge ROML' : 'RAM' },
      { range: '0000-7FFF', read: 'RAM' },
    ]
    : [
      { range: 'C000-FFFF', read: ((cr >> 4) & 3) === 2 ? func(ROM_AT_C000[2], mem.extRom) : ROM_AT_C000[(cr >> 4) & 3] },
      { range: 'D000-DFFF', read: mem.ioIn ? 'I/O' : 'Character ROM / system ROM / RAM' },
      { range: '8000-BFFF', read: ((cr >> 2) & 3) === 2 ? func(ROM_AT_8000[2], mem.extRom) : ROM_AT_8000[(cr >> 2) & 3] },
      { range: '4000-7FFF', read: cr & 0x02 ? 'RAM' : 'BASIC low ROM' },
      { range: '0000-3FFF', read: 'RAM' },
    ];
  const registers = [
    { name: 'Mode', value: `${m.c64Mode ? 'C64' : 'C128'}, ${m.cpuIs8502 ? '8502' : 'Z80'}` },
    { name: 'Clock', value: m.fast2MHz ? '2 MHz (VIC-IIe reads the CPU bus)' : '1 MHz' },
    { name: 'MMU CR', value: `$${hex8(cr)} (RAM block ${mmu.ramBlock})` },
    { name: 'MMU RCR', value: `$${hex8(mmu.rcr)} (common ${mmu.commonSize >> 10}K, VIC-IIe block ${mmu.vicBlock})` },
    { name: '8502 port', value: `$${hex8(mem.portData)} (DDR $${hex8(mem.portDdr)})` },
    { name: 'VIC bank', value: `${vicBank} ($${hex8(vicBank << 6)}00)` },
    { name: 'Screen', value: `$${screen.toString(16).toUpperCase().padStart(4, '0')}` },
    { name: 'Display', value: m.showing80 ? '80 columns (VDC)' : '40 columns (VIC-IIe)' },
    { name: 'Cassette', value: mem.motorOn ? 'motor on' : 'motor off' },
  ];
  if (cart) {
    registers.push({ name: 'Cartridge', value: `${C64_CART_TYPE_NAMES[cart.type]}, EXROM ${exrom} GAME ${game}${ultimax ? ' (Ultimax)' : ''}` });
  } else if (mem.extRom) {
    registers.push({ name: 'Cartridge', value: '128 function ROM' });
  }
  if (mmu.relocated) {
    registers.push({ name: 'Pages 0/1', value: `-> $${hex8(mmu.p0l)}/$${hex8(mmu.p1l)}` });
  }
  return { slots, registers };
}

export class C128Inspection implements MachineInspection {
  constructor(private readonly m: C128Machine) {}

  memoryMap() { return c128MemoryMap(this.m); }

  // BASIC 7.0 in C128 mode; the 64's V2 in C64 mode.
  basicListing() {
    return this.m.c64Mode
      ? parseC64Basic(this.m.memory.ram.subarray(0, 0x10000))
      : parseC128Basic(this.m.memory.ram);
  }

  basicVars() {
    return this.m.c64Mode
      ? parseC64BasicVariables(this.m.memory.ram.subarray(0, 0x10000))
      : parseC128BasicVariables(this.m.memory.ram);
  }
}
