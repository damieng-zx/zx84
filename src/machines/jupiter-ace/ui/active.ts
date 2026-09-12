/**
 * The active machine, narrowed to a concrete `JupiterAceMachine` — or null when
 * another machine is running.
 *
 * The shell holds a machine-blind `Machine` handle; the Ace's own UI
 * contributions (the on-screen keyboard) legitimately reach their machine's
 * internals, so the narrowing lives HERE, in the machine's `ui/` layer, not in
 * the shell. A `ui/` module is allowed to import the shell context and its own
 * machine class (dependency-cruiser `machines-no-ui` exempts `ui/`).
 */

import { machine } from '@/shell/context.ts';
import type { JupiterAceMachine } from '@/machines/jupiter-ace/ace-machine.ts';

/** The running machine as a `JupiterAceMachine`, or null on any other machine. */
export function activeAce(): JupiterAceMachine | null {
  return machine && machine.kind === 'jupiter-ace' ? (machine as unknown as JupiterAceMachine) : null;
}
