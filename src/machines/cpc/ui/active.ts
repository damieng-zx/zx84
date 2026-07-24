/**
 * CPC-owned UI access to the currently running CPC motherboard.
 */

import { machine } from '@/shell/context.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

export function activeCpc(): CpcMachine | null {
  return machine && machine.kind === 'cpc'
    ? (machine as unknown as CpcMachine)
    : null;
}
