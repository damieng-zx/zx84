/**
 * SAM RomService — the single 32K system-ROM socket.
 *
 * The SAM's ROM 0 and ROM 1 are the two halves of one physical EPROM, so there
 * is one slot, never two independently-overridable pages (`ui.romPages` is 0).
 * There is no cartridge port: SAMDOS and MasterDOS load from disk into RAM.
 *
 * The host owns override storage and the rebuild; headless, the setters no-op.
 */

import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';
import type { SamMachine } from '../sam-machine.ts';

export class SamRomService implements RomService {
  constructor(
    private readonly m: SamMachine,
    private readonly host: () => MachineHost | null,
  ) {}

  get systemSlots(): readonly RomSlotInfo[] {
    const c = this.host()?.roms?.cached() ?? null;
    return [{
      index: 0,
      label: c?.label ?? '',
      size: c?.size ?? 0,
      overridden: c?.isCustom ?? false,
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

  /** No cartridge port on the SAM. */
  readonly cartridge: CartridgeSlot | null = null;
}
