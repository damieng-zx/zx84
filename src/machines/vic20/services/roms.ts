/**
 * Vic20RomService — one socket per ROM chip: BASIC, the KERNAL and the
 * character ROM, each independently overridable (at an 8K stride, as on the
 * C64; see `VIC20_ROM_SLOT_SIZE`). An override is cut to its chip's size.
 * Cartridges arrive in Phase 4 of the plan.
 */

import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';
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

  /** No cartridge slot yet (Phase 4 of the plan). */
  readonly cartridge: CartridgeSlot | null = null;

  async resetSystemRom(page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    if (page === undefined) await ops.clearFull();
    else await ops.clearPage(page);
    await ops.rebuild();
  }
}
