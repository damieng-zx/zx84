/**
 * Atari-owned UI access to the currently running Atari motherboard.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { AtariMachine } from '@/machines/atari/atari-machine.ts';

export function activeAtari(): AtariMachine | null {
  return narrowMachine<AtariMachine>(machine, 'atari');
}
