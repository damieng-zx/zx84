/**
 * CpcConfig — per-model capability/strategy object for the Amstrad CPC family.
 *
 * The CPC analogue of the Spectrum's `MachineVariant`, but CPC-shaped: it
 * describes RAM size, disk presence, CRTC type, and ROM layout rather than
 * ULA contention and 0x7FFD decode. Only the 6128 ships today; 464/664 entries
 * are the documented extension point (different RAM, ROM set, and — for the 464
 * — no built-in disk controller).
 */

import type { CpcModel } from '@/models.ts';

export interface CpcConfig {
  readonly model: CpcModel;
  /** Total RAM in KB (128 for 6128, 64 for 464/664). */
  readonly ramKB: number;
  /** Number of 16KB RAM banks (8 for 6128, 4 for 464/664). */
  readonly ramBanks: number;
  /** Whether a uPD765A floppy controller + AMSDOS is present. */
  readonly hasFDC: boolean;
  /** Whether a cassette deck is wired up. False on the GX4000 console. */
  readonly hasTape: boolean;
  /**
   * CRTC chip type. The 6128 commonly ships a type-0 (HD6845S) or type-1
   * (UM6845R); a handful of register-read/edge-case behaviours differ between
   * types and are gated on this. The Plus ASIC integrates a type-4 CRTC.
   * Default 0.
   */
  readonly crtcType: 0 | 1 | 2 | 3 | 4;
  /** True for the Plus range (6128+ and GX4000) — gate array replaced by the
   *  Amstrad ASIC (sprites, soft scroll, split screen, raster IRQ, DMA sound,
   *  cartridge port). Selects `Asic extends GateArray` instead of `GateArray`. */
  readonly isPlus: boolean;
  /** Human-readable ROM-set description (UI / status). */
  readonly romLabel: string;
}

const CPC6128: CpcConfig = {
  model: 'cpc6128',
  ramKB: 128,
  ramBanks: 8,
  hasFDC: true,
  hasTape: true,
  crtcType: 0,
  isPlus: false,
  romLabel: 'CPC 6128 (OS + BASIC 1.1 + AMSDOS)',
};

const CPC464: CpcConfig = {
  model: 'cpc464',
  ramKB: 64,
  ramBanks: 4,
  hasFDC: false, // cassette only — no uPD765A / AMSDOS
  hasTape: true,
  crtcType: 0,
  isPlus: false,
  romLabel: 'CPC 464 (OS + BASIC 1.0, cassette only)',
};

const CPC664: CpcConfig = {
  model: 'cpc664',
  ramKB: 64,
  ramBanks: 4,
  hasFDC: true, // 3" drive + AMSDOS, like the 6128 but 64KB
  hasTape: true,
  crtcType: 0,
  isPlus: false,
  romLabel: 'CPC 664 (OS + BASIC 1.1 + AMSDOS)',
};

const CPC6128PLUS: CpcConfig = {
  model: 'cpc6128plus',
  ramKB: 128,
  ramBanks: 8,
  hasFDC: true,                  // 3" drive, same uPD765A as the 6128
  hasTape: true,                 // 6128Plus keeps the tape socket; 464Plus internal
  crtcType: 4,                   // ASIC-integrated CRTC
  isPlus: true,                  // Amstrad ASIC replaces the gate array
  romLabel: 'CPC 6128Plus (cartridge: OS 4 + BASIC 1.1 + AMSDOS)',
};

const GX4000: CpcConfig = {
  model: 'gx4000',
  ramKB: 128,
  ramBanks: 8,
  hasFDC: false,                 // console — no floppy
  hasTape: false,                // console — no cassette
  crtcType: 4,                   // same ASIC as the 6128Plus
  isPlus: true,
  romLabel: 'GX4000 (cartridge only)',
};

/** Build the config for a CPC model. */
export function createCpcConfig(model: CpcModel): CpcConfig {
  switch (model) {
    case 'cpc6128':
      return CPC6128;
    case 'cpc464':
      return CPC464;
    case 'cpc664':
      return CPC664;
    case 'cpc6128plus':
      return CPC6128PLUS;
    case 'gx4000':
      return GX4000;
  }
}
