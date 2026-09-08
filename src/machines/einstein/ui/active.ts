/**
 * Einstein-owned UI access to the currently running Tatung motherboard.
 */

import { machine } from '@/shell/context.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';

export function activeEinstein(): EinsteinMachine | null {
  return machine && machine.kind === 'einstein'
    ? (machine as unknown as EinsteinMachine)
    : null;
}
