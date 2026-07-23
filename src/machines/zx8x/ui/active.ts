/**
 * The active machine, narrowed to a concrete `Zx8xMachine` — or null when
 * another machine is running.
 *
 * The shell holds a machine-blind `Machine` handle; the ZX80/ZX81's own UI
 * contributions (hardware section, on-screen keyboard) legitimately reach their
 * machine's internals, so the narrowing lives HERE, in the machine's `ui/`
 * layer, not in the shell. A `ui/` module is allowed to import the shell context
 * and its own machine class (dependency-cruiser `machines-no-ui` exempts `ui/`).
 */

import { machine } from '@/shell/context.ts';
import type { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';

/** The running machine as a `Zx8xMachine`, or null on any other machine. */
export function activeZx8x(): Zx8xMachine | null {
  return machine && machine.kind === 'zx8x' ? (machine as unknown as Zx8xMachine) : null;
}
