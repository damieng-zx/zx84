/** Atom-owned UI access to the currently running motherboard. */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { AtomMachine } from '../atom-machine.ts';

export function activeAtom(): AtomMachine | null {
  return narrowMachine<AtomMachine>(machine, 'atom');
}
