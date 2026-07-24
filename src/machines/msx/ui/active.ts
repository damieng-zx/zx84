/**
 * MSX-owned UI access to the currently running Toshiba motherboard.
 */

import { machine } from '@/shell/context.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';

export function activeMsx(): MsxMachine | null {
  return machine && machine.kind === 'msx'
    ? (machine as unknown as MsxMachine)
    : null;
}
