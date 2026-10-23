/**
 * BBC-owned UI access to the currently running BBC Micro motherboard.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { BbcMachine } from '@/machines/bbc/bbc-machine.ts';

export function activeBbc(): BbcMachine | null {
  return narrowMachine<BbcMachine>(machine, 'bbc');
}
