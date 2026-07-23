import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';
import type { MtxMachine } from '../mtx-machine.ts';

class MtxRomPackSlot implements CartridgeSlot {
  private mountedName = '';

  constructor(private readonly machine: MtxMachine) {}

  get name(): string { return this.mountedName; }

  insert(data: Uint8Array, name: string): void {
    this.machine.stop();
    this.machine.memory.insertRomPack(data);
    this.mountedName = name;
    this.machine.reset();
  }

  eject(): void {
    this.machine.stop();
    this.machine.memory.ejectRomPack();
    this.mountedName = '';
    this.machine.reset();
  }
}

export class MtxRomService implements RomService {
  private readonly slot: MtxRomPackSlot;

  constructor(
    private readonly machine: MtxMachine,
    private readonly host: () => MachineHost | null,
  ) {
    this.slot = new MtxRomPackSlot(machine);
  }

  get systemSlots(): readonly RomSlotInfo[] {
    const cached = this.host()?.roms?.cached() ?? null;
    return [{
      index: 0,
      label: cached?.label ?? '',
      size: cached?.size ?? 0,
      overridden: cached?.isCustom ?? false,
    }];
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

  get cartridge(): CartridgeSlot { return this.slot; }
}
