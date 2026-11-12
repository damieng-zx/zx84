/**
 * C128RomService — one socket per ROM chip: BASIC low, BASIC high, the system
 * ROM, the character ROM, and C64 mode's BASIC and KERNAL, each independently
 * overridable. The chips differ in size, so a socket sits at its own offset in
 * the six images end to end (`C128_ROM_SLOT_OFFSETS`); an override is cut to its
 * chip's size. The DOS ROM of each drive fitted is a socket of its own.
 */

import type {
  MachineHost, RomService, RomSlotInfo, SidewaysRomSlot,
} from '@/machines/machine.ts';
import type { C128Machine } from '../c128-machine.ts';
import {
  C128_ROM_CHIP_SIZES, C128_ROM_SLOT_LABELS, C128_ROM_SLOT_OFFSETS, C128_ROM_TOTAL,
} from '../models.ts';
import { cbmDriveRomSlots, installCbmDriveRom } from '@/machines/shared/cbm/drive-services.ts';

export class C128RomService implements RomService {
  constructor(
    private readonly m: C128Machine,
    private readonly host: () => MachineHost | null,
  ) {}

  get systemSlots(): readonly RomSlotInfo[] {
    const ops = this.host()?.roms;
    return C128_ROM_SLOT_LABELS.map((title, index): RomSlotInfo => {
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
    // The six ROMs end to end, dropped on any socket, fill every socket.
    if (data.length >= C128_ROM_TOTAL) {
      for (let i = 0; i < C128_ROM_CHIP_SIZES.length; i++) {
        const at = C128_ROM_SLOT_OFFSETS[i];
        await ops.persistPage(i, data.subarray(at, at + C128_ROM_CHIP_SIZES[i]), `${label} (${C128_ROM_SLOT_LABELS[i]})`);
      }
    } else {
      await ops.persistPage(page, data.subarray(0, C128_ROM_CHIP_SIZES[page] ?? 0), label);
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

  /** No cartridge slot yet (64 mode's expansion port and 128 mode's function
   *  ROM sockets are not modelled). */
  readonly cartridge = null;

  /** The DOS ROMs are sockets of their own, one per drive model fitted. */
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
}
