import type {
  CartridgeSlot, MachineHost, RomService, RomSlotInfo,
} from '@/machines/machine.ts';
import type { Apple1Machine } from '../apple1-machine.ts';

/** The Apple I has a single ROM: the 256-byte Woz Monitor. */
export class Apple1RomService implements RomService {
  constructor(
    private readonly machine: Apple1Machine,
    private readonly host: () => MachineHost | null,
  ) {}

  get systemSlots(): readonly RomSlotInfo[] { return []; }

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

  get cartridge(): CartridgeSlot | null { return null; }
}
