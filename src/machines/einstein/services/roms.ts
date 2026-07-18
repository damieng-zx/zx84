/**
 * Einstein RomService — the single 8KB MOS boot-monitor socket. No cartridge.
 *
 * The host owns override storage and the rebuild that makes a new ROM take
 * effect (RomHostOps); with no host attached (headless) the setters are no-ops.
 */

import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';

export class EinsteinRomService implements RomService {
  constructor(private readonly host: () => MachineHost | null) {}

  get systemSlots(): readonly RomSlotInfo[] {
    const c = this.host()?.roms?.cached() ?? null;
    return [{ index: 0, label: c?.label ?? '', size: c?.size ?? 0, overridden: c?.isCustom ?? false }];
  }

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
