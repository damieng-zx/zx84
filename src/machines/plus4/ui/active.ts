/**
 * Plus/4-owned UI access to the currently running machine (the Plus/4 and the
 * Commodore 16 share the board, so this reaches either).
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { Plus4Machine } from '@/machines/plus4/plus4-machine.ts';

export function activePlus4(): Plus4Machine | null {
  return narrowMachine<Plus4Machine>(machine, 'plus4');
}
