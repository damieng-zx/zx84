/**
 * PCW RomService — the machine that hasn't got one.
 *
 * A PCW contains no ROM: on reset the gate array invents a bootstrap routine
 * that pulls the boot sector off drive A, and everything after that comes from
 * disc. So there is no slot to show, nothing to override and nothing to reset;
 * `descriptor.ui.systemRomSlot` is false and the ROM pane hides the row rather
 * than showing an empty one.
 *
 * The service still exists because the SPI requires one — the shell calls
 * `installSystemRom` with an empty image on every build.
 */

import type { CartridgeSlot, RomService, RomSlotInfo } from '@/machines/machine.ts';
import type { PcwMachine } from '../pcw-machine.ts';

export class PcwRomService implements RomService {
  constructor(private readonly m: PcwMachine) {}

  readonly systemSlots: readonly RomSlotInfo[] = [];

  installSystemRom(data: Uint8Array): void { this.m.loadROM(data); }

  async setSystemRom(_data: Uint8Array, _label: string, _page?: number): Promise<void> {}

  async resetSystemRom(_page?: number): Promise<void> {}

  readonly cartridge: CartridgeSlot | null = null;
}
