/**
 * Amstrad CPC family model type and classification helpers.
 *
 * The CPC is a different machine, not a Spectrum variant — it gets its own
 * model union so the Spectrum helpers stay closed over their own values and
 * never have to consider a CPC value. `MachineModel` (in `@/models.ts`) is the
 * open union used by model-agnostic plumbing.
 */

import type { MachineModel } from '@/models.ts';

/** Amstrad CPC models. Only 'cpc6128' ships today; the others are the
 *  extension point for the 464/664 (different RAM/ROM/CRTC). */
export type CpcModel = 'cpc6128' | 'cpc464' | 'cpc664';

/** Type guard: true for any Amstrad CPC model. */
export function isCpcModel(m: MachineModel): m is CpcModel {
  return m === 'cpc6128' || m === 'cpc464' || m === 'cpc664';
}

/** True for a CPC model with a built-in disk drive (664/6128 have a uPD765A;
 *  the 464 is cassette only). Used to gate disk UI / hardware. */
export function cpcHasDisk(m: MachineModel): boolean {
  return m === 'cpc6128' || m === 'cpc664';
}
