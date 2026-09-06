/**
 * The active machine, narrowed to a concrete `SamMachine` — or null when
 * another machine is running.
 *
 * The shell holds a machine-blind `Machine` handle; the SAM's own UI
 * contributions (hardware section, system variables) legitimately reach their
 * machine's internals, so the narrowing lives HERE, in the machine's `ui/`
 * layer, not in the shell. See `spectrum/ui/active.ts` for the same seam.
 */

import { machine } from '@/shell/context.ts';
import type { SamMachine } from '../sam-machine.ts';

/** The running machine as a `SamMachine`, or null on any other machine. */
export function activeSam(): SamMachine | null {
  return machine && machine.kind === 'sam' ? (machine as unknown as SamMachine) : null;
}
