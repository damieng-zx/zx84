/**
 * Apple I-owned UI access to the currently running motherboard.
 */

import { machine } from '@/shell/context.ts';
import type { Apple1Machine } from '@/machines/apple1/apple1-machine.ts';

export function activeApple1(): Apple1Machine | null {
  return machine && machine.kind === 'apple1'
    ? (machine as unknown as Apple1Machine)
    : null;
}
