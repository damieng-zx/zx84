import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';
import type { Zx8xMachine } from '../zx8x-machine.ts';

export class Zx8xRomService implements RomService {
  constructor(private readonly machine: Zx8xMachine, private readonly host: () => MachineHost | null) {}

  get systemSlots(): readonly RomSlotInfo[] {
    const cached = this.host()?.roms?.cached() ?? null;
    return [{ index: 0, label: cached?.label ?? '', size: cached?.size ?? 0, overridden: cached?.isCustom ?? false }];
  }

  installSystemRom(data: Uint8Array): void { this.machine.loadROM(data); }

  async setSystemRom(data: Uint8Array, label: string): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.persistFull(data, label);
    await ops.rebuild();
  }

  async resetSystemRom(): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.clearFull();
    await ops.rebuild();
  }

  readonly cartridge: CartridgeSlot | null = null;
}
