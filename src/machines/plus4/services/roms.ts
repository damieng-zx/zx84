/**
 * Plus4RomService — one socket per ROM chip: the KERNAL and BASIC (and, on the
 * Plus/4, the two 3+1 function ROMs), each independently overridable. An
 * override is cut to its chip's size. The cartridge slot takes `.crt` files and
 * raw ROM images; the drives' DOS ROMs are sockets of their own.
 */

import type {
  CartridgeSlot, MachineHost, RomService, RomSlotInfo, SidewaysRomSlot,
} from '@/machines/machine.ts';
import { cbmDriveRomSlots, installCbmDriveRom } from '@/machines/shared/cbm/drive-services.ts';
import { parsePlus4Cartridge } from '../cartridge.ts';
import type { Plus4Machine } from '../plus4-machine.ts';
import { plus4RomChipSizes, plus4RomSize, plus4RomSlotLabels } from '../models.ts';

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

export class Plus4RomService implements RomService {
  constructor(
    private readonly m: Plus4Machine,
    private readonly host: () => MachineHost | null,
  ) {}

  get systemSlots(): readonly RomSlotInfo[] {
    const ops = this.host()?.roms;
    return plus4RomSlotLabels(this.m.model).map((title, index): RomSlotInfo => {
      const p = ops?.cachedPage(index) ?? null;
      return { index, title, label: p?.label ?? title, size: p?.size ?? 0, overridden: p !== null };
    });
  }

  installSystemRom(data: Uint8Array): void { this.m.loadROM(data); }

  async setSystemRom(data: Uint8Array, label: string, page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    if (page === undefined) {
      await ops.persistFull(data, label);
      await ops.rebuild();
      return;
    }
    // The whole image, dropped on any socket, fills every socket.
    const sizes = plus4RomChipSizes(this.m.model);
    if (data.length >= plus4RomSize(this.m.model)) {
      let at = 0;
      const labels = plus4RomSlotLabels(this.m.model);
      for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i];
        await ops.persistPage(i, data.subarray(at, at + size), `${label} (${labels[i]})`);
        at += size;
      }
    } else {
      await ops.persistPage(page, data.subarray(0, sizes[page] ?? 0), label);
    }
    await ops.rebuild();
  }

  /** The drives' DOS ROMs, one socket per drive model fitted. */
  get sidewaysSlots(): readonly SidewaysRomSlot[] { return cbmDriveRomSlots(this.m.iec); }

  installSidewaysRom(index: number, data: Uint8Array): void { installCbmDriveRom(this.m.iec, index, data); }

  async setSidewaysRom(index: number, data: Uint8Array, label: string): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.persistSideways(index, data, label);
    await ops.rebuild();
  }

  async resetSidewaysRom(index: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.clearSideways(index);
    await ops.rebuild();
  }

  readonly cartridge: CartridgeSlot = new Plus4CartridgeSlot(this.m);

  async resetSystemRom(page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    if (page === undefined) await ops.clearFull();
    else await ops.clearPage(page);
    await ops.rebuild();
  }
}
