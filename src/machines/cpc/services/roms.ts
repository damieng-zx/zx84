/**
 * CPC RomService — the single system-ROM socket (concatenated OS + BASIC
 * [+ AMSDOS]). The CPC has no user-facing cartridge slot, so `cartridge` is null.
 *
 * The host owns override storage and the rebuild that makes a new ROM take
 * effect (RomHostOps); with no host attached (headless) the setters are no-ops.
 */

import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

export class CpcRomService implements RomService {
  constructor(private readonly c: CpcMachine, private readonly host: () => MachineHost | null) {}

  get systemSlots(): readonly RomSlotInfo[] {
    const c = this.host()?.roms?.cached() ?? null;
    return [{ index: 0, label: c?.label ?? '', size: c?.size ?? 0, overridden: c?.isCustom ?? false }];
  }

  installSystemRom(data: Uint8Array): void { this.c.loadROM(data); }

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
