/**
 * MSX RomService — the 32KB internal BIOS+BASIC socket and the slot-1 cartridge
 * slot. Inserting or removing a cartridge power-cycles the machine so the BIOS
 * slot scan finds (and auto-runs) it — matching real hardware. The shell restarts
 * the machine afterwards (it knows whether a ROM is loaded).
 */

import type { CartridgeSlot, MachineHost } from '@/machines/machine.ts';
import { SingleRomService } from '@/machines/shared/single-rom-service.ts';
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

export class MsxRomService extends SingleRomService<MsxMachine> {
  private readonly slot: MsxCartridgeSlot;

  constructor(machine: MsxMachine, host: () => MachineHost | null) {
    super(machine, host);
    this.slot = new MsxCartridgeSlot(machine);
  }

  override get cartridge(): CartridgeSlot { return this.slot; }
}
