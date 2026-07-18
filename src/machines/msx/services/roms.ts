/**
 * MSX RomService — the 32KB internal BIOS+BASIC socket and the slot-1 cartridge
 * slot. Inserting or removing a cartridge power-cycles the machine so the BIOS
 * slot scan finds (and auto-runs) it — matching real hardware. The shell restarts
 * the machine afterwards (it knows whether a ROM is loaded).
 *
 * The host owns system-ROM override storage + the rebuild; headless, the system
 * setters are no-ops.
 */

import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';

class MsxCartridgeSlot implements CartridgeSlot {
  constructor(private readonly m: MsxMachine) {}

  get name(): string { return this.m.cartridgeName; }

  insert(data: Uint8Array, name: string): void {
    this.m.stop();
    this.m.insertCartridge(data, name);
    this.m.reset();
  }

  eject(): void {
    this.m.stop();
    this.m.ejectCartridge();
    this.m.reset();
  }
}

export class MsxRomService implements RomService {
  private readonly slot: MsxCartridgeSlot;

  constructor(private readonly m: MsxMachine, private readonly host: () => MachineHost | null) {
    this.slot = new MsxCartridgeSlot(m);
  }

  get systemSlots(): readonly RomSlotInfo[] {
    const c = this.host()?.roms?.cached() ?? null;
    return [{ index: 0, label: c?.label ?? '', size: c?.size ?? 0, overridden: c?.isCustom ?? false }];
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

  get cartridge(): CartridgeSlot { return this.slot; }
}
