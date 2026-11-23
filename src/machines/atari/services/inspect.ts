/**
 * Atari 8-bit on-demand inspection: the Memory layout pane (which follows the
 * XL's PORTB banking live) and the BASIC listing and variables panes.
 *
 * Separate from the frame probe because these are asked for on demand and may
 * allocate, while `sample()` runs every rAF and must not.
 */

import type { MachineInspection, MemoryMapSnapshot, MemoryMapSlot } from '@/machines/machine.ts';
import { isAtariBasicRom, parseAtariBasic, parseAtariBasicVariables } from '@/basic/atari-basic-parser.ts';
import type { AtariMachine } from '../atari-machine.ts';

function hex(v: number, width: number): string {
  return v.toString(16).toUpperCase().padStart(width, '0');
}

export class AtariInspection implements MachineInspection {
  constructor(private readonly m: AtariMachine) {}

  /**
   * Whether Atari BASIC is the ROM in the $A000 window, and so owns the
   * zero-page pointers the parsers read: the left cartridge on the 400/800
   * and 1200XL (or an XL with the internal BASIC switched off), or the
   * 600XL/800XL's built-in BASIC while PORTB bit 1 has it enabled. Another
   * cartridge, or none, means no listing.
   */
  private basicResident(): boolean {
    const mem = this.m.memory;
    const cart = mem.cart;
    if (cart !== null && cart.enabled) return cart.type === 'std8' && isAtariBasicRom(cart.image);
    return mem.basicRomEnabled && mem.basicRom !== null && isAtariBasicRom(mem.basicRom);
  }

  basicListing() {
    return this.basicResident() ? parseAtariBasic(this.m.memory.ram) : [];
  }

  basicVars() {
    return this.basicResident() ? parseAtariBasicVariables(this.m.memory.ram) : [];
  }

  memoryMap(): MemoryMapSnapshot {
    const mem = this.m.memory;
    const cart = mem.cart;
    const slots: MemoryMapSlot[] = [];
    /** RAM if fitted at `top` (exclusive end of the range), else unmapped. */
    const ram = (top: number) => (mem.ramSize >= top ? 'RAM' : 'Unmapped');
    /** A ROM over RAM: reads the ROM, writes are lost (XL with 64K). */
    const overRam = (range: string, rom: string, top: number): MemoryMapSlot =>
      (mem.ramSize >= top ? { range, read: rom, write: 'Ignored (RAM hidden)' } : { range, read: rom });

    const osIn = mem.osRomEnabled;
    if (!mem.xl || osIn) {
      slots.push(overRam('E000-FFFF', 'OS ROM', 0x10000));
      slots.push(overRam('D800-DFFF', 'Floating-point ROM', 0x10000));
    } else {
      slots.push({ range: 'D800-FFFF', read: ram(0x10000) });
    }
    slots.push({ range: 'D500-D7FF', read: 'Unmapped' });
    slots.push({ range: 'D400-D4FF', read: 'ANTIC' });
    slots.push({ range: 'D300-D3FF', read: 'PIA' });
    slots.push({ range: 'D200-D2FF', read: 'POKEY' });
    slots.push({ range: 'D100-D1FF', read: 'Unmapped' });
    slots.push({ range: 'D000-D0FF', read: 'GTIA' });
    if (!mem.xl) slots.push({ range: 'C000-CFFF', read: 'Unmapped' });
    else if (osIn) slots.push(overRam('C000-CFFF', 'OS ROM', 0xD000));
    else slots.push({ range: 'C000-CFFF', read: ram(0xD000) });

    if (cart !== null && cart.base === 0x8000) {
      slots.push({ range: '8000-BFFF', read: 'Cartridge (16K)' });
    } else {
      const a000 = cart?.enabled ? (cart.bankSwitched ? `Cartridge (${cart.type.toUpperCase()})` : 'Cartridge')
        : mem.basicRomEnabled ? 'BASIC ROM' : null;
      slots.push(a000 ? overRam('A000-BFFF', a000, 0xC000) : { range: 'A000-BFFF', read: ram(0xC000) });
      slots.push({ range: '8000-9FFF', read: ram(0xA000) });
    }
    // The 130XE's banked window: the CPU and ANTIC each see the extended
    // bank only when PORTB says so, so the two views can differ.
    const window = mem.cpuExtEnabled || mem.anticExtEnabled
      ? `${mem.cpuExtEnabled ? `Extended RAM bank ${mem.extBank}` : 'RAM'}`
        + `${mem.anticExtEnabled !== mem.cpuExtEnabled
          ? `, ANTIC sees ${mem.anticExtEnabled ? `bank ${mem.extBank}` : 'main RAM'}` : ''}`
      : ram(0x8000);
    if (mem.selfTestRomEnabled) {
      slots.push({ range: '5800-7FFF', read: window });
      slots.push(overRam('5000-57FF', 'Self-test ROM', 0x5800));
      slots.push({ range: '4000-4FFF', read: window });
    } else {
      slots.push({ range: '4000-7FFF', read: window });
    }
    slots.push({ range: '0000-3FFF', read: 'RAM' });

    return {
      slots,
      registers: [
        { name: 'DMACTL', value: hex(this.m.antic.dmactl, 2) },
        { name: 'DLIST', value: hex(this.m.antic.dlist, 4) },
        { name: 'COLBK', value: hex(this.m.gtia.colbk, 2) },
        { name: 'PRIOR', value: hex(this.m.gtia.prior, 2) },
        { name: 'SKCTL', value: hex(this.m.pokey.skctl, 2) },
        ...(mem.xl ? [{ name: 'PORTB', value: hex(mem.portB, 2) }] : []),
      ],
    };
  }
}
