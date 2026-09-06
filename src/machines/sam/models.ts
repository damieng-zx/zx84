/**
 * SAM Coupé family model type and classification helpers.
 *
 * The SAM shipped as a 256K machine with an internal upgrade to 512K, and
 * those two are the whole family: they run the same 32K ROM and differ only in
 * how many internal pages answer.
 *
 * External RAM is deliberately NOT a model. The third-party megabyte interface
 * is a box you plug in and can fill with 1-4 MB, reachable through the LEPR and
 * HEPR page registers, so it is a fitted-hardware setting on either machine
 * rather than a third variant — see `SamMemory.setExternalPages`.
 */

import type { MachineModel } from '@/models.ts';
import {
  SAM_EXTERNAL_PAGES_PER_MB, SAM_MAX_EXTERNAL_MB,
  SAM_PAGES_256K, SAM_PAGES_512K,
} from './constants.ts';

/** SAM Coupé models. */
export type SamModel = 'sam256' | 'sam512';

/** Type guard: true for any SAM Coupé model. */
export function isSamModel(m: MachineModel): m is SamModel {
  return m === 'sam256' || m === 'sam512';
}

/** Internal 16K pages fitted for a model (16 = 256K, 32 = 512K). The megabyte
 *  interface is *external* memory and does not change this count. */
export function samInternalPages(model: SamModel): number {
  return model === 'sam256' ? SAM_PAGES_256K : SAM_PAGES_512K;
}

/** External 16K pages for a megabyte-interface size, clamped to what the 8-bit
 *  page registers can address. 0 MB means no interface fitted at all. */
export function samExternalPages(megabytes: number): number {
  const mb = Math.max(0, Math.min(SAM_MAX_EXTERNAL_MB, Math.floor(megabytes)));
  return mb * SAM_EXTERNAL_PAGES_PER_MB;
}
