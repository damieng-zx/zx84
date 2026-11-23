/**
 * Acorn Atom on-demand inspection: the BASIC program and variables area.
 *
 * Atom BASIC stores plain ASCII line records in the text space; its variables
 * are the A-Z integer columns and the AA-ZZ arrays.
 */

import type { MachineInspection } from '@/machines/machine.ts';
import { parseAtomBasic, parseAtomBasicVariables } from '@/basic/atom-basic-parser.ts';
import type { AtomMachine } from '../atom-machine.ts';

export class AtomInspection implements MachineInspection {
  constructor(private readonly machine: AtomMachine) {}

  basicListing() { return parseAtomBasic(this.machine.memory.ram); }

  basicVars() { return parseAtomBasicVariables(this.machine.memory.ram); }
}
