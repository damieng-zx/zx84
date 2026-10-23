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
 * `installSystemRom` with an empty image on every build. With no host there is
 * nothing for the setters to persist or rebuild.
 */

import { SingleRomService } from '@/machines/shared/single-rom-service.ts';
import type { PcwMachine } from '../pcw-machine.ts';

export class PcwRomService extends SingleRomService<PcwMachine> {
  protected override readonly showSlot = false;

  constructor(machine: PcwMachine) { super(machine, () => null); }
}
