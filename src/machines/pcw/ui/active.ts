/**
 * PCW-owned UI access to the currently running motherboard.
 */

import { machine } from '@/shell/context.ts';
import type { PcwMachine } from '@/machines/pcw/pcw-machine.ts';

export function activePcw(): PcwMachine | null {
  return machine && machine.kind === 'pcw'
    ? (machine as unknown as PcwMachine)
    : null;
}
