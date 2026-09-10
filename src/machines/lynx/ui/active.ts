/**
 * Lynx-owned UI access to the currently running Camputers motherboard.
 */

import { machine } from '@/shell/context.ts';
import type { LynxMachine } from '@/machines/lynx/lynx-machine.ts';

export function activeLynx(): LynxMachine | null {
  return machine && machine.kind === 'lynx'
    ? (machine as unknown as LynxMachine)
    : null;
}
