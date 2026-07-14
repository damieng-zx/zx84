/**
 * EinsteinConfig — per-model capability object for the Tatung Einstein family.
 *
 * The Einstein analogue of the CPC's `CpcConfig`. Only the TC-01 ships today;
 * the field set is the documented extension point for later variants (e.g. the
 * 256K Einstein 256 with its different RAM/video).
 */

import type { EinsteinModel } from '@/models.ts';

export interface EinsteinConfig {
  readonly model: EinsteinModel;
  /** Total RAM in KB. */
  readonly ramKB: number;
  /** Number of 16KB RAM banks. */
  readonly ramBanks: number;
  /** Whether a WD1770 floppy controller is present. */
  readonly hasFDC: boolean;
  /** Human-readable ROM-set description (UI / status). */
  readonly romLabel: string;
}

const TC01: EinsteinConfig = {
  model: 'einstein',
  ramKB: 64,
  ramBanks: 4,
  hasFDC: true,
  romLabel: 'Tatung Einstein TC-01 (MOS)',
};

/** Build the config for an Einstein model. */
export function createEinsteinConfig(model: EinsteinModel): EinsteinConfig {
  switch (model) {
    case 'einstein':
      return TC01;
  }
}
