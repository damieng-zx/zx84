/**
 * BBC Micro on-demand inspection: the tokenised BASIC program in main RAM from
 * PAGE, and its variables in the heap above TOP plus the resident A%-Z%.
 */

import type { MachineInspection } from '@/machines/machine.ts';
import { parseBbcBasic, parseBbcBasicVariables } from '@/basic/bbc-basic-parser.ts';
import type { BbcMachine } from '../bbc-machine.ts';

export class BbcInspection implements MachineInspection {
  constructor(private readonly machine: BbcMachine) {}

  basicListing() { return parseBbcBasic(this.machine.memory.ram); }

  basicVars() { return parseBbcBasicVariables(this.machine.memory.ram); }
}
