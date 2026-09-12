/**
 * Jupiter Ace family model type and classification helpers.
 *
 * The Jupiter Ace (Jupiter Cantab, 1983) is a Z80 machine designed by the
 * Spectrum team (Altwasser's ULA, Vickers' ROM) that shipped with FORTH in ROM
 * instead of BASIC. Only the original 3KB model ships today (RAM expansions
 * are not modelled).
 */

import type { MachineModel } from '@/models.ts';

/** Jupiter Ace models. Only the original 1983 machine ships today. */
export type JupiterAceModel = 'jupiter-ace';

/** Type guard: true for any Jupiter Ace model. */
export function isJupiterAceModel(m: MachineModel): m is JupiterAceModel {
  return m === 'jupiter-ace';
}
