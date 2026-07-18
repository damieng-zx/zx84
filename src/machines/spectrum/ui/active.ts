/**
 * The active machine, narrowed to a concrete `Spectrum` — or null when another
 * machine is running.
 *
 * The shell holds a machine-blind `Machine` handle (services + SPI only); the
 * Spectrum's own UI contributions (hardware section, on-screen keyboard,
 * sysvars, Multiface button) legitimately reach their machine's internals, so
 * the narrowing lives HERE, in the machine's `ui/` layer, not in the shell.
 * A `ui/` module is allowed to import the shell context and its own machine
 * class (dependency-cruiser `machines-no-ui` exempts `ui/`).
 */

import { machine } from '@/shell/context.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';

/** The running machine as a `Spectrum`, or null on any other machine. */
export function activeSpectrum(): Spectrum | null {
  return machine && machine.kind === 'spectrum' ? (machine as unknown as Spectrum) : null;
}
