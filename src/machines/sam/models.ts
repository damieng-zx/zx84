/**
 * SAM Coupé family model type and classification helpers.
 *
 * The SAM shipped as a 256K machine with an internal upgrade to 512K; a
 * third-party "megabyte interface" adds a further 1 MB reachable through the
 * external page registers (LEPR/HEPR). All three run the same 32K ROM, so they
 * differ only in how many memory pages exist and whether the external window
 * responds at all.
 */

import type { MachineModel } from '@/models.ts';
import { SAM_PAGES_256K, SAM_PAGES_512K } from './constants.ts';

/** SAM Coupé models. */
export type SamModel = 'sam256' | 'sam512' | 'sam1m';

/** Type guard: true for any SAM Coupé model. */
export function isSamModel(m: MachineModel): m is SamModel {
  return m === 'sam256' || m === 'sam512' || m === 'sam1m';
}

/** Internal 16K pages fitted for a model (16 = 256K, 32 = 512K). The megabyte
 *  interface is *external* memory and does not change this count. */
export function samInternalPages(model: SamModel): number {
  return model === 'sam256' ? SAM_PAGES_256K : SAM_PAGES_512K;
}

/** True when the external megabyte interface is fitted, so HMPR bit 7 pages
 *  the LEPR/HEPR window into sections C/D instead of internal RAM. */
export function samHasMegabyte(model: SamModel): boolean {
  return model === 'sam1m';
}
