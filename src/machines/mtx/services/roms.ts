import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';
import type { MtxMachine } from '../mtx-machine.ts';
import { MTX_ROM_SLOT_SIZE, MTX_ROM_SLOT_LABELS } from '../models.ts';

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

  // Five independently-overridable 8K firmware slots (OS, BASIC, ASSEM, CP/M
  // bootstrap, FDX Disk BASIC), in the concatenation order MtxMemory.loadRom
  // expects. An empty label falls back to the slot's default ROM name.
  get systemSlots(): readonly RomSlotInfo[] {
    const ops = this.host()?.roms;
    return MTX_ROM_SLOT_LABELS.map((defaultLabel, index) => {
      const p = ops?.cachedPage(index) ?? null;
      return {
        index,
        title: defaultLabel,
        label: p?.label ?? defaultLabel,
        size: p?.size ?? 0,
        overridden: p !== null,
      };
    });
  }

  installSystemRom(data: Uint8Array): void { this.machine.loadROM(data); }

  async setSystemRom(data: Uint8Array, label: string, page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    if (page === undefined) {
      await ops.persistFull(data, label);
      await ops.rebuild();
      return;
    }
    // A full concatenated firmware image dropped on any one slot splits across
    // all five — matching the real ROM layout — so loading a combined dump
    // "just works" regardless of which slot triggered it.
    const count = MTX_ROM_SLOT_LABELS.length;
    if (data.length >= count * MTX_ROM_SLOT_SIZE) {
      for (let i = 0; i < count; i++) {
        await ops.persistPage(
          i,
          data.subarray(i * MTX_ROM_SLOT_SIZE, (i + 1) * MTX_ROM_SLOT_SIZE),
          `${label} (rom ${i + 1})`,
        );
      }
    } else {
      await ops.persistPage(page, data.subarray(0, MTX_ROM_SLOT_SIZE), label);
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

  get cartridge(): CartridgeSlot { return this.slot; }
}
