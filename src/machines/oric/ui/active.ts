/**
 * Oric-owned UI access to the currently running motherboard.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { OricMachine } from '@/machines/oric/oric-machine.ts';

export function activeOric(): OricMachine | null {
  return narrowMachine<OricMachine>(machine, 'oric');
}
