/**
 * Vic20RomService — one socket per ROM chip: BASIC, the KERNAL and the
 * character ROM, each independently overridable (8K chips on an 8K stride,
 * the character ROM 4K). An override is cut to its chip's size. The cartridge
 * slot takes `.crt` files and raw or load-address ROM images; the drives' DOS
 * ROMs are sockets of their own.
 */

import type { CartridgeSlot, MachineHost } from '@/machines/machine.ts';
import type { Vic20Machine } from '../vic20-machine.ts';
import { VIC20_ROM_CHIP_SIZES, VIC20_ROM_SLOT_LABELS } from '../models.ts';
import { parseVic20Cartridge } from '../cartridge.ts';
import { cbmRomSockets, CbmDosRomSockets, CbmRomServiceBase } from '@/machines/shared/cbm/rom-service.ts';

class Vic20CartridgeSlot implements CartridgeSlot {
  constructor(private readonly m: Vic20Machine) {}

  get name(): string {
    const cart = this.m.cartridge;
    return cart ? this.m.cartridgeFile || cart.name || 'Cartridge' : '';
  }

  insert(data: Uint8Array, name: string): void {
    const parsed = parseVic20Cartridge(data, name);
    if ('error' in parsed) { this.m.onStatus?.(parsed.error); return; }
    this.m.mountCartridge(parsed.cart, name);
  }

  eject(): void { this.m.ejectCartridge(); }
}

export class Vic20RomService extends CbmRomServiceBase {
  readonly cartridge: CartridgeSlot;

  constructor(m: Vic20Machine, host: () => MachineHost | null) {
    super(
      (data) => m.loadROM(data),
      host,
      () => cbmRomSockets(VIC20_ROM_SLOT_LABELS, VIC20_ROM_CHIP_SIZES, 0x2000),
      new CbmDosRomSockets(m.iec, host),
    );
    this.cartridge = new Vic20CartridgeSlot(m);
  }
}
