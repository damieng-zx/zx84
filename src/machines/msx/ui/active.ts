/**
 * MSX-owned UI access to the currently running Toshiba motherboard.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';

export function activeMsx(): MsxMachine | null {
  return narrowMachine<MsxMachine>(machine, 'msx');
}
