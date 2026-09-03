/**
 * SamConfig — per-model capability object for the SAM Coupé family.
 *
 * The SAM analogue of `CpcConfig`: the three models share a motherboard, a ROM
 * and every peripheral, and differ only in how much memory answers. Keeping
 * that in one object means `SamMemory` never has to ask which model it is on.
 */

import type { SamModel } from './models.ts';
import { samHasMegabyte, samInternalPages } from './models.ts';
import { SAM_EXTERNAL_PAGES } from './constants.ts';

export interface SamConfig {
  readonly model: SamModel;
  /** Internal 16K pages fitted (16 = 256K, 32 = 512K). */
  readonly internalPages: number;
  /** External 16K pages reachable through LEPR/HEPR (0 when not fitted). */
  readonly externalPages: number;
  /** Whether HMPR bit 7 (MCNTRL) pages external memory rather than reading
   *  open bus. */
  readonly hasMegabyte: boolean;
  /** Human-readable memory description (UI / status). */
  readonly ramLabel: string;
}

export function createSamConfig(model: SamModel): SamConfig {
  const internalPages = samInternalPages(model);
  const hasMegabyte = samHasMegabyte(model);
  return {
    model,
    internalPages,
    externalPages: hasMegabyte ? SAM_EXTERNAL_PAGES : 0,
    hasMegabyte,
    ramLabel: hasMegabyte ? '512K + 1MB external' : `${internalPages * 16}K`,
  };
}
