/**
 * Apple II-owned UI access to the currently running motherboard.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';

export function activeApple2(): Apple2Machine | null {
  return narrowMachine<Apple2Machine>(machine, 'apple2');
}
