/**
 * PCW-owned UI access to the currently running motherboard.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { PcwMachine } from '@/machines/pcw/pcw-machine.ts';

export function activePcw(): PcwMachine | null {
  return narrowMachine<PcwMachine>(machine, 'pcw');
}
