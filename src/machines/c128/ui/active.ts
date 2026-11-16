/**
 * C128-owned UI access to the currently running Commodore 128.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { C128Machine } from '@/machines/c128/c128-machine.ts';

export function activeC128(): C128Machine | null {
  return narrowMachine<C128Machine>(machine, 'c128');
}
