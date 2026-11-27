/** System-owned UI access to the currently running motherboard. */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { AcornSystemMachine } from '../machine.ts';

export function activeAcornSystem(): AcornSystemMachine | null {
  return narrowMachine<AcornSystemMachine>(machine, 'acorn-system');
}
