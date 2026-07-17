/**
 * MsxConfig — per-model capability object for the MSX family.
 *
 * The MSX analogue of `EinsteinConfig` / `CpcConfig`. Only the Toshiba HX-10
 * ships today; the field set is the documented extension point for later MSX1
 * models (which differ mainly in RAM size and slot layout).
 */

import type { MsxModel } from '@/models.ts';

export interface MsxConfig {
  readonly model: MsxModel;
  /** Total RAM in KB. */
  readonly ramKB: number;
  /** Number of 16KB RAM banks. */
  readonly ramBanks: number;
  /** Whether a floppy controller is present (the HX-10 has none). */
  readonly hasFDC: boolean;
  /** Human-readable ROM-set description (UI / status). */
  readonly romLabel: string;
}

const HX10: MsxConfig = {
  model: 'hx-10',
  ramKB: 64,
  ramBanks: 4,
  hasFDC: false,
  romLabel: 'Toshiba HX-10 (MSX BASIC 1.0)',
};

/** Build the config for an MSX model. */
export function createMsxConfig(model: MsxModel): MsxConfig {
  switch (model) {
    case 'hx-10':
      return HX10;
  }
}
