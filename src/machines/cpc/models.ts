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
 *  extension point for the 464/664 (different RAM/ROM/CRTC) and the Plus range
 *  (cpc6128plus / gx4000) which replaces the gate array with the Amstrad ASIC
 *  — sprites, soft scroll, split screen, raster IRQ, DMA sound, cartridge. */
export type CpcModel = 'cpc6128' | 'cpc464' | 'cpc664' | 'cpc6128plus' | 'gx4000';

/** Type guard: true for any Amstrad CPC model. */
export function isCpcModel(m: MachineModel): m is CpcModel {
  return m === 'cpc6128' || m === 'cpc464' || m === 'cpc664'
      || m === 'cpc6128plus' || m === 'gx4000';
}

/** True for a CPC model with a built-in disk drive (664/6128 have a uPD765A;
 *  the 464 is cassette only). Used to gate disk UI / hardware. The Plus range
 *  keeps the same uPD765A on the 6128Plus; the GX4000 console has none. */
export function cpcHasDisk(m: MachineModel): boolean {
  return m === 'cpc6128' || m === 'cpc664' || m === 'cpc6128plus';
}

/** True for a CPC model with the cassette deck wired up. The 464/664/6128
 *  expose a tape port; the Plus range adds a cartridge port instead, and the
 *  GX4000 console drops the cassette entirely. */
export function cpcHasTape(m: MachineModel): boolean {
  return m === 'cpc6128' || m === 'cpc464' || m === 'cpc664' || m === 'cpc6128plus';
}

/** True for a CPC model built around the Amstrad ASIC (the Plus range): 6128+
 *  and GX4000 share the ASIC's sprites, soft scroll, split screen, raster IRQ,
 *  DMA sound, and cartridge port. The non-Plus 464/664/6128 use the discrete
 *  Gate Array instead. */
export function cpcIsPlusClass(m: MachineModel): boolean {
  return m === 'cpc6128plus' || m === 'gx4000';
}
