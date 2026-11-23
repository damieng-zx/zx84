/**
 * Acorn Electron on-demand inspection: the tokenised BASIC program in main RAM
 * from PAGE (BASIC II, as on the BBC Micro).
 */

import type { MachineInspection } from '@/machines/machine.ts';
import { parseBbcBasic, parseBbcBasicVariables } from '@/basic/bbc-basic-parser.ts';
import type { ElectronMachine } from '../electron-machine.ts';

export class ElectronInspection implements MachineInspection {
  constructor(private readonly machine: ElectronMachine) {}

  basicListing() { return parseBbcBasic(this.machine.memory.ram); }

  basicVars() { return parseBbcBasicVariables(this.machine.memory.ram); }
}
