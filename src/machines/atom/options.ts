/**
 * Acorn Atom Hardware-pane options.
 *
 * The standard Atom has 2 KB of RAM (1 KB of CPU workspace and 1 KB of video
 * RAM, shared between the 512-byte text screen and the upper text space). The
 * everyday 12 KB expansion adds 5 KB of lower text RAM at $2800-$3BFF and
 * extends the video RAM to 6 KB at $8000-$97FF, which is what nearly all Atom
 * software assumes.
 */

import type { SettingsView } from '@/machines/machine.ts';
import { ATOM_RAM_KB_12, ATOM_RAM_KB_2 } from './constants.ts';

export interface AtomOptions {
  /** Total fitted RAM in KB: 2 (standard) or 12 (fully expanded). */
  readonly ramKb: 2 | 12;
}

export const ATOM_DEFAULT_OPTIONS: AtomOptions = { ramKb: ATOM_RAM_KB_12 };

/** Parse the Hardware pane's RAM setting; anything unrecognised is 12 KB. */
export function parseAtomRam(value: unknown): 2 | 12 {
  return value === '2k' || value === ATOM_RAM_KB_2 ? 2 : ATOM_RAM_KB_12;
}

export function readAtomOptions(view: SettingsView): AtomOptions {
  return { ramKb: parseAtomRam(view.get<string>('atom-ram', '12k')) };
}
