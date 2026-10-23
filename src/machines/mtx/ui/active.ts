/**
 * MTX-owned UI access to the currently running Memotech motherboard.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { MtxMachine } from '@/machines/mtx/mtx-machine.ts';

export function activeMtx(): MtxMachine | null {
  return narrowMachine<MtxMachine>(machine, 'mtx');
}
