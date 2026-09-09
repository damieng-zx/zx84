/**
 * LynxRomService — one system-ROM socket holding the 8K images end to end
 * (two on the 48K, three on the 96K). No cartridge slot.
 */

import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';
import type { LynxMachine } from '../lynx-machine.ts';

export class LynxRomService implements RomService {
  constructor(
    private readonly m: LynxMachine,
    private readonly host: () => MachineHost | null,
  ) {}

  get systemSlots(): readonly RomSlotInfo[] {
    const cached = this.host()?.roms?.cached() ?? null;
    return [{
      index: 0,
      label: cached?.label ?? '',
      size: cached?.size ?? 0,
      overridden: cached?.isCustom ?? false,
    }];
  }

  installSystemRom(data: Uint8Array): void { this.m.loadROM(data); }

  async setSystemRom(data: Uint8Array, label: string, _page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.persistFull(data, label);
    await ops.rebuild();
  }

  async resetSystemRom(_page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.clearFull();
    await ops.rebuild();
  }

  readonly cartridge: CartridgeSlot | null = null;
}
