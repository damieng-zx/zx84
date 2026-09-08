/**
 * MTX-owned UI access to the currently running Memotech motherboard.
 */

import { machine } from '@/shell/context.ts';
import type { MtxMachine } from '@/machines/mtx/mtx-machine.ts';

export function activeMtx(): MtxMachine | null {
  return machine && machine.kind === 'mtx'
    ? (machine as unknown as MtxMachine)
    : null;
}
