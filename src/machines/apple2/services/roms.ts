import type {
  CartridgeSlot, MachineHost, RomService, RomSlotInfo,
} from '@/machines/machine.ts';
import type { Apple2Machine } from '../apple2-machine.ts';

/** The Apple II has a single system ROM (Applesoft + Monitor); the Disk II
 *  card ROM is a peripheral image loaded at build time, not a user slot. */
export class Apple2RomService implements RomService {
  constructor(
    private readonly machine: Apple2Machine,
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
