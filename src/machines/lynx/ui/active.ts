/**
 * Lynx-owned UI access to the currently running Camputers motherboard.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { LynxMachine } from '@/machines/lynx/lynx-machine.ts';

export function activeLynx(): LynxMachine | null {
  return narrowMachine<LynxMachine>(machine, 'lynx');
}
