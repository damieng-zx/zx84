/**
 * Einstein-owned UI access to the currently running Tatung motherboard.
 */

import { machine } from '@/shell/context.ts';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';

export function activeEinstein(): EinsteinMachine | null {
  return narrowMachine<EinsteinMachine>(machine, 'einstein');
}
