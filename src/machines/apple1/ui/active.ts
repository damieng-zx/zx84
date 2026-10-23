/**
 * Apple I-owned UI access to the currently running motherboard.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { Apple1Machine } from '@/machines/apple1/apple1-machine.ts';

export function activeApple1(): Apple1Machine | null {
  return narrowMachine<Apple1Machine>(machine, 'apple1');
}
