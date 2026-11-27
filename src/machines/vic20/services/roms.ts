/**
 * Vic20RomService — one socket per ROM chip: BASIC, the KERNAL and the
 * character ROM, each independently overridable (at an 8K stride, as on the
 * C64; see `VIC20_ROM_SLOT_SIZE`). An override is cut to its chip's size.
 * The cartridge slot takes `.crt` files and raw or load-address ROM images;
 * the drives' DOS ROMs are sockets of their own.
 */

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

import type {
  CartridgeSlot, MachineHost, RomService, RomSlotInfo, SidewaysRomSlot,
} from '@/machines/machine.ts';
import { cbmDriveRomSlots, installCbmDriveRom } from '@/machines/shared/cbm/drive-services.ts';
import { parseVic20Cartridge } from '../cartridge.ts';
import type { Vic20Machine } from '../vic20-machine.ts';
import { VIC20_ROM_CHIP_SIZES, VIC20_ROM_SLOT_LABELS } from '../models.ts';
import { VIC20_ROM_SIZE } from '../constants.ts';

export class Vic20RomService implements RomService {
  constructor(
    private readonly m: Vic20Machine,
    private readonly host: () => MachineHost | null,
  ) {}

  get systemSlots(): readonly RomSlotInfo[] {
    const ops = this.host()?.roms;
    return VIC20_ROM_SLOT_LABELS.map((title, index): RomSlotInfo => {
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
    // The three ROMs end to end, dropped on any socket, fill every socket.
    if (data.length >= VIC20_ROM_SIZE) {
      let at = 0;
      for (let i = 0; i < VIC20_ROM_CHIP_SIZES.length; i++) {
        const size = VIC20_ROM_CHIP_SIZES[i];
        await ops.persistPage(i, data.subarray(at, at + size), `${label} (${VIC20_ROM_SLOT_LABELS[i]})`);
        at += 0x2000;
      }
    } else {
      await ops.persistPage(page, data.subarray(0, VIC20_ROM_CHIP_SIZES[page] ?? 0), label);
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

  readonly cartridge: CartridgeSlot = new Vic20CartridgeSlot(this.m);

  async resetSystemRom(page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    if (page === undefined) await ops.clearFull();
    else await ops.clearPage(page);
    await ops.rebuild();
  }
}
