/**
 * Acorn System on-demand inspection: the BASIC program and variables area.
 */

import type { MachineInspection } from '@/machines/machine.ts';
import { systemBasicListing, systemBasicVariables } from '../basic.ts';
import type { AcornSystemMachine } from '../machine.ts';

export class AcornSystemInspection implements MachineInspection {
  constructor(private readonly m: AcornSystemMachine) {}

  basicListing() { return systemBasicListing(this.m.memory); }

  basicVars() { return systemBasicVariables(this.m.memory); }
}
