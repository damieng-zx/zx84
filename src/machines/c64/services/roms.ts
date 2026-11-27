/**
 * C64RomService — one socket per ROM chip: BASIC, the KERNAL and the
 * character ROM, each independently overridable (8K chips on an 8K stride,
 * the character ROM 4K). An override is cut to its chip's size. The cartridge
 * slot takes `.crt` files. The DOS ROMs are sockets of their own, one per
 * drive model fitted.
 */

import type { CartridgeSlot, MachineHost } from '@/machines/machine.ts';
import type { C64Machine } from '../c64-machine.ts';
import { C64_ROM_CHIP_SIZES, C64_ROM_SLOT_LABELS } from '../models.ts';
import { parseCrt } from '../cartridge.ts';
import { cbmRomSockets, CbmDosRomSockets, CbmRomServiceBase } from '@/machines/shared/cbm/rom-service.ts';

class C64CartridgeSlot implements CartridgeSlot {
  constructor(private readonly m: C64Machine) {}

  get name(): string {
    const cart = this.m.cartridge;
    return cart ? this.m.cartridgeFile || cart.name || 'Cartridge' : '';
  }

  insert(data: Uint8Array, name: string): void {
    const parsed = parseCrt(data);
    if ('error' in parsed) { this.m.onStatus?.(parsed.error); return; }
    this.m.mountCartridge(parsed.cart, name);
  }

  eject(): void { this.m.ejectCartridge(); }
}

export class C64RomService extends CbmRomServiceBase {
  readonly cartridge: CartridgeSlot;

  constructor(m: C64Machine, host: () => MachineHost | null) {
    super(
      (data) => m.loadROM(data),
      host,
      () => cbmRomSockets(C64_ROM_SLOT_LABELS, C64_ROM_CHIP_SIZES, 0x2000),
      new CbmDosRomSockets(m.iec, host),
    );
    this.cartridge = new C64CartridgeSlot(m);
  }
}
