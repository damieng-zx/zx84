/**
 * BBC-owned UI access to the currently running BBC Micro motherboard.
 */

import { machine } from '@/shell/context.ts';
import type { BbcMachine } from '@/machines/bbc/bbc-machine.ts';

export function activeBbc(): BbcMachine | null {
  return machine && machine.kind === 'bbc'
    ? (machine as unknown as BbcMachine)
    : null;
}
