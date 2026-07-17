/**
 * Tatung Einstein family model type and classification helpers.
 *
 * Like the CPC, the Einstein is a different machine, not a Spectrum variant —
 * a Z80A with a TMS9918A VDP, AY-3-8910 and WD1770 FDC. It gets its own model
 * union so the Spectrum/CPC helpers stay closed over their own values.
 */

import type { MachineModel } from '@/models.ts';

/** Tatung Einstein models. Only the TC-01 ships today. */
export type EinsteinModel = 'einstein';

/** Type guard: true for any Tatung Einstein model. */
export function isEinsteinModel(m: MachineModel): m is EinsteinModel {
  return m === 'einstein';
}
