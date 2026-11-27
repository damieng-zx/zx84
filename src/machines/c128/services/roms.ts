/**
 * C128RomService — one socket per ROM chip: BASIC low, BASIC high, the system
 * ROM, the character ROM, and C64 mode's BASIC and KERNAL, each independently
 * overridable. The chips differ in size, so a socket sits at its own offset in
 * the six images end to end. The cartridge slot takes a 64 cartridge or a 128
 * function ROM (`.crt`, or a bare 8K/16K/32K image). The DOS ROM of each drive
 * fitted is a socket of its own.
 */

import type { CartridgeSlot, MachineHost } from '@/machines/machine.ts';
import type { C128Machine } from '../c128-machine.ts';
import {
  C128_ROM_CHIP_SIZES, C128_ROM_SLOT_LABELS, C128_ROM_SLOT_OFFSETS,
} from '../models.ts';
import { parseC128Cartridge } from '../function-rom.ts';
import { CbmDosRomSockets, CbmRomServiceBase } from '@/machines/shared/cbm/rom-service.ts';
import type { CbmRomSocket } from '@/machines/shared/cbm/rom-service.ts';

/** The expansion port: a 64 cartridge (64 mode), or a function ROM the 128 runs from (128 mode). */
class C128CartridgeSlot implements CartridgeSlot {
  constructor(private readonly m: C128Machine) {}

  get name(): string {
    const cart = this.m.cartridge;
    return cart ? this.m.cartridgeFile || cart.name || 'Cartridge' : '';
  }

  insert(data: Uint8Array, name: string): void {
    const parsed = parseC128Cartridge(data, name);
    if ('error' in parsed) { this.m.onStatus?.(parsed.error); return; }
    this.m.mountCartridge('cart' in parsed ? parsed.cart : parsed.rom, name);
  }

  eject(): void { this.m.ejectCartridge(); }
}

export class C128RomService extends CbmRomServiceBase {
  readonly cartridge: CartridgeSlot;

  constructor(m: C128Machine, host: () => MachineHost | null) {
    super(
      (data) => m.loadROM(data),
      host,
      () => C128_ROM_SLOT_LABELS.map((label, i): CbmRomSocket => ({
        label, size: C128_ROM_CHIP_SIZES[i], offset: C128_ROM_SLOT_OFFSETS[i],
      })),
      new CbmDosRomSockets(m.iec, host),
    );
    this.cartridge = new C128CartridgeSlot(m);
  }
}
