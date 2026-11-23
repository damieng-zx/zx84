/**
 * ZX80/ZX81 on-demand inspection: the BASIC program and variables area, read
 * from the machine's 16 KB address space with the tokens of its own model.
 *
 * Separate from the frame probe because this is asked for on demand and may
 * allocate, while `sample()` runs every rAF and must not.
 */

import type { MachineInspection } from '@/machines/machine.ts';
import type { Zx8xMachine } from '../zx8x-machine.ts';
import { parseZx8xBasicProgram, parseZx8xBasicVariables } from '../basic.ts';

export class Zx8xInspection implements MachineInspection {
  constructor(private readonly machine: Zx8xMachine) {}

  basicListing() {
    return parseZx8xBasicProgram(this.machine.memory.snapshot(), this.machine.model);
  }

  basicVars() {
    return parseZx8xBasicVariables(this.machine.memory.snapshot(), this.machine.model);
  }
}
