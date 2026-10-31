/**
 * C64RomService — one socket per ROM chip: BASIC, the KERNAL and the
 * character ROM, each independently overridable (the MTX-style multi-slot
 * machinery at an 8K stride, see `C64_ROM_SLOT_SIZE`). An override is cut to
 * its chip's size. The cartridge slot takes `.crt` files.
 */

import type {
  CartridgeSlot, MachineHost, RomService, RomSlotInfo, SidewaysRomSlot,
} from '@/machines/machine.ts';
import type { C64Machine } from '../c64-machine.ts';
import { C64_ROM_CHIP_SIZES, C64_ROM_SLOT_LABELS } from '../models.ts';
import { C64_ROM_SIZE } from '../constants.ts';
import { parseCrt } from '../cartridge.ts';
import { C64_DRIVE_MODELS } from '../drive/drive-unit.ts';

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

export class C64RomService implements RomService {
  constructor(
    private readonly m: C64Machine,
    private readonly host: () => MachineHost | null,
  ) {}

  get systemSlots(): readonly RomSlotInfo[] {
    const ops = this.host()?.roms;
    return C64_ROM_SLOT_LABELS.map((title, index): RomSlotInfo => {
      const p = ops?.cachedPage(index) ?? null;
      return {
        index,
        title,
        label: p?.label ?? title,
        size: p?.size ?? 0,
        overridden: p !== null,
      };
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
    if (data.length >= C64_ROM_SIZE) {
      let at = 0;
      for (let i = 0; i < C64_ROM_CHIP_SIZES.length; i++) {
        const size = C64_ROM_CHIP_SIZES[i];
        await ops.persistPage(i, data.subarray(at, at + size), `${label} (${C64_ROM_SLOT_LABELS[i]})`);
        at += size;
      }
    } else {
      await ops.persistPage(page, data.subarray(0, C64_ROM_CHIP_SIZES[page] ?? 0), label);
    }
    await ops.rebuild();
  }

  async resetSystemRom(page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    if (page === undefined) await ops.clearFull();
    else await ops.clearPage(page);
    await ops.rebuild();
  }

  readonly cartridge: CartridgeSlot = new C64CartridgeSlot(this.m);

  /** The DOS ROMs are sockets of their own, one per drive model fitted (the
   *  drives of a model share it). The index is the model's, so a stored
   *  override stays with its model whichever drives are fitted. */
  get sidewaysSlots(): readonly SidewaysRomSlot[] {
    const out: SidewaysRomSlot[] = [];
    C64_DRIVE_MODELS.forEach((model, index) => {
      const drive = this.m.drives.find(d => d.model === model);
      if (!drive) return;
      out.push({
        index,
        title: `${model} DOS`,
        label: drive.hasRom ? `${model} DOS ROM` : '',
        size: drive.hasRom ? drive.romSize : 0,
        overridden: false,
      });
    });
    return out;
  }

  installSidewaysRom(index: number, data: Uint8Array): void {
    const model = C64_DRIVE_MODELS[index];
    if (model) this.m.installDriveRom(model, data);
  }

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
}
