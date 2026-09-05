/**
 * SamConfig — per-model capability object for the SAM Coupé family.
 *
 * The SAM analogue of `CpcConfig`: the two models share a motherboard, a ROM
 * and every peripheral, and differ only in how much internal memory answers.
 * Keeping that in one object means `SamMemory` never has to ask which model it
 * is on.
 *
 * External RAM is the *initial* size only. It is a fitted-hardware setting the
 * user can change without rebuilding the machine, so `SamMemory` owns the live
 * count and this field just seeds it.
 */

import type { SamModel } from './models.ts';
import { samExternalPages, samInternalPages } from './models.ts';

export interface SamConfig {
  readonly model: SamModel;
  /** Internal 16K pages fitted (16 = 256K, 32 = 512K). */
  readonly internalPages: number;
  /** External 16K pages to start with (0 when no megabyte interface). */
  readonly externalPages: number;
}

export function createSamConfig(model: SamModel, externalMb = 0): SamConfig {
  return {
    model,
    internalPages: samInternalPages(model),
    externalPages: samExternalPages(externalMb),
  };
}

/** Human-readable memory description for the UI and status line. */
export function samRamLabel(internalPages: number, externalPages: number): string {
  const internal = `${internalPages * 16}K`;
  if (externalPages === 0) return internal;
  return `${internal} + ${externalPages / 64}MB external`;
}
