/**
 * CPC-owned UI access to the currently running CPC motherboard.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

export function activeCpc(): CpcMachine | null {
  return narrowMachine<CpcMachine>(machine, 'cpc');
}
