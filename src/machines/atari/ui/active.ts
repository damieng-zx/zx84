/**
 * Atari-owned UI access to the currently running Atari motherboard.
 */

import { machine } from '@/shell/context.ts';
import type { AtariMachine } from '@/machines/atari/atari-machine.ts';

export function activeAtari(): AtariMachine | null {
  return machine && machine.kind === 'atari'
    ? (machine as unknown as AtariMachine)
    : null;
}
