/**
 * Plus4RomService — one socket per ROM chip: the KERNAL and BASIC (and, on the
 * Plus/4, the two 3+1 function ROMs), each independently overridable. An
 * override is cut to its chip's size. The cartridge slot takes `.crt` files and
 * raw ROM images; the drives' DOS ROMs are sockets of their own.
 */

import type { CartridgeSlot, MachineHost } from '@/machines/machine.ts';
import type { Plus4Machine } from '../plus4-machine.ts';
import { parsePlus4Cartridge } from '../cartridge.ts';
import { plus4RomChipSizes, plus4RomSlotLabels } from '../models.ts';
import { CbmDosRomSockets, CbmRomServiceBase } from '@/machines/shared/cbm/rom-service.ts';
import type { CbmRomSocket } from '@/machines/shared/cbm/rom-service.ts';

class Plus4CartridgeSlot implements CartridgeSlot {
  constructor(private readonly m: Plus4Machine) {}

  get name(): string {
    const cart = this.m.cartridge;
    return cart ? this.m.cartridgeFile || cart.name || 'Cartridge' : '';
  }

  insert(data: Uint8Array, name: string): void {
    const parsed = parsePlus4Cartridge(data, name);
    if ('error' in parsed) { this.m.onStatus?.(parsed.error); return; }
    this.m.mountCartridge(parsed.cart, name);
  }

  eject(): void { this.m.ejectCartridge(); }
}

export class Plus4RomService extends CbmRomServiceBase {
  readonly cartridge: CartridgeSlot;

  constructor(m: Plus4Machine, host: () => MachineHost | null) {
    super(
      (data) => m.loadROM(data),
      host,
      () => {
        const sizes = plus4RomChipSizes(m.model);
        const labels = plus4RomSlotLabels(m.model);
        let at = 0;
        return labels.map((label, i): CbmRomSocket => {
          const socket = { label, size: sizes[i], offset: at };
          at += sizes[i];
          return socket;
        });
      },
      new CbmDosRomSockets(m.iec, host),
    );
    this.cartridge = new Plus4CartridgeSlot(m);
  }
}
