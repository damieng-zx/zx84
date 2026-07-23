/**
 * EinsteinConfig — per-model capability object for the Tatung Einstein family.
 *
 * The Einstein analogue of the CPC's `CpcConfig`. The TC-01 ships a TMS9929A
 * with 16KB VRAM; the Einstein 256 swaps in a V9938 with 192KB VRAM (the
 * "256" is 64K CPU RAM + 192K video RAM — the CPU memory map is unchanged),
 * a 16KB MOS 2.1 ROM, alpha-lock and system-status ports, and drops the PIO,
 * ADC0844, Tatung Pipe and external drives (MAME's einst256 driver).
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
  /** Video chip: TMS9929A (TC-01) or V9938 (Einstein 256). */
  readonly vdp: 'tms9929' | 'v9938';
  /** MOS ROM size in KB: 8 (TC-01, mirrored ×2) or 16 (256, no mirror). */
  readonly romSizeKB: number;
  /** Whether the MOS mirror-loads across the low 16KB (TC-01 only). */
  readonly romMirrored: boolean;
  /** Active display width in pixels (256 TMS, 512 V9938). */
  readonly activeWidth: number;
  /** Active display height in pixels (192 TMS, 212 V9938). */
  readonly activeHeight: number;
  /** ALPHA LOCK key + latch port 0x22 / system-status port 0x26 (256 only). */
  readonly hasAlphaLock: boolean;
  /** Human-readable ROM-set description (UI / status). */
  readonly romLabel: string;
}

const TC01: EinsteinConfig = {
  model: 'einstein',
  ramKB: 64,
  ramBanks: 4,
  hasFDC: true,
  vdp: 'tms9929',
  romSizeKB: 8,
  romMirrored: true,
  activeWidth: 256,
  activeHeight: 192,
  hasAlphaLock: false,
  romLabel: 'Tatung Einstein TC-01 (MOS)',
};

const TCS256: EinsteinConfig = {
  model: 'einstein-256',
  ramKB: 64,
  ramBanks: 4,
  hasFDC: true,
  vdp: 'v9938',
  romSizeKB: 16,
  romMirrored: false,
  activeWidth: 512,
  activeHeight: 212,
  hasAlphaLock: true,
  romLabel: 'Tatung Einstein 256 (MOS 2.1)',
};

/** Build the config for an Einstein model. */
export function createEinsteinConfig(model: EinsteinModel): EinsteinConfig {
  switch (model) {
    case 'einstein':
      return TC01;
    case 'einstein-256':
      return TCS256;
  }
}
