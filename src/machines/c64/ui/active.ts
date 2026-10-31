/**
 * C64-owned UI access to the currently running Commodore 64.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { C64Machine } from '@/machines/c64/c64-machine.ts';

export function activeC64(): C64Machine | null {
  return narrowMachine<C64Machine>(machine, 'c64');
}
