/**
 * VIC-20-owned UI access to the currently running VIC-20.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { Vic20Machine } from '@/machines/vic20/vic20-machine.ts';

export function activeVic20(): Vic20Machine | null {
  return narrowMachine<Vic20Machine>(machine, 'vic20');
}
