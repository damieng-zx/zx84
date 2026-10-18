/**
 * MsxConfig — per-model capability object for the MSX family.
 *
 * The MSX analogue of `EinsteinConfig` / `CpcConfig`. The MSX1 models differ in
 * video standard (PAL 50 Hz / NTSC 60 Hz), RAM size and slot layout, and in which
 * firmware ROMs they carry — all of it lives here.
 */

import type { MsxModel } from '@/models.ts';
import { MSX_NTSC_FRAME_HZ, MSX_NTSC_LINES, MSX_PAL_FRAME_HZ, MSX_PAL_LINES, MSX_T_PER_FRAME, MSX_NTSC_T_PER_FRAME } from '@/machines/msx/constants.ts';
import type { MsxMemoryLayout } from '@/machines/msx/msx-memory.ts';

export interface MsxConfig {
  readonly model: MsxModel;
  /** Total RAM in KB. */
  readonly ramKB: number;
  /** Number of 16KB RAM banks. */
  readonly ramBanks: number;
  /** Whether a floppy controller is present (no MSX1 model here has one built in). */
  readonly hasFDC: boolean;
  /** Human-readable ROM-set description (UI / status). */
  readonly romLabel: string;
  /** Scanlines per field: 313 (PAL TMS9929A) or 262 (NTSC TMS9918A). */
  readonly linesPerFrame: number;
  /** Nominal field rate (Hz) used for wall-clock frame pacing. */
  readonly frameHz: number;
  /** CPU T-states per field (lines × 228 on real hardware; the HX-10 keeps its
   *  historical 3.579545 MHz / 50 Hz figure). */
  readonly tStatesPerFrame: number;
  /** How the on-board memory is arranged across the primary slots. */
  readonly layout: MsxMemoryLayout;
  /** Optional on-board firmware ROM (the HB-55's Personal Data Bank): hosted
   *  name under `roms/`, its size in bytes, and the cache key for the fetch. */
  readonly firmware: { readonly source: string; readonly size: number; readonly cacheKey: string; readonly label: string } | null;
  /** System ROM (BIOS + BASIC) hosted name under `roms/`. */
  readonly biosSource: string;
}

const HX10: MsxConfig = {
  model: 'hx-10',
  ramKB: 64,
  ramBanks: 4,
  hasFDC: false,
  romLabel: 'Toshiba HX-10 (MSX BASIC 1.0)',
  linesPerFrame: MSX_PAL_LINES,
  frameHz: MSX_PAL_FRAME_HZ,
  tStatesPerFrame: MSX_T_PER_FRAME,
  // Slot 0: 32KB ROM; slot 2: 64KB RAM; slot 1 cartridge; slot 3 expansion.
  layout: { ramSlot: 2, ramFirstPage: 0, firmwarePage: null },
  firmware: null,
  biosSource: 'msx/hx-10_basic-bios1.rom',
};

/** Sony HB-55 (Japan, 1983): NTSC TMS9918A, 32KB BIOS+BASIC (JIS font) in slot 0
 *  pages 0–1, an 8KB Personal Data Bank ROM at 0x8000 (slot 0 page 2) and just
 *  16KB of RAM at 0xC000 (slot 0 page 3). Slot 1 is the cartridge slot and slot 3
 *  the expansion bus. There are no sub-slots (MAME msx1.cpp `hb55`, openMSX
 *  Sony_HB-55P.xml, MSX Wiki). */
const HB55: MsxConfig = {
  model: 'hb-55',
  ramKB: 16,
  ramBanks: 1,
  hasFDC: false,
  romLabel: 'Sony HB-55 (MSX BASIC 1.0, Japanese)',
  linesPerFrame: MSX_NTSC_LINES,
  frameHz: MSX_NTSC_FRAME_HZ,
  tStatesPerFrame: MSX_NTSC_T_PER_FRAME,
  layout: { ramSlot: 0, ramFirstPage: 3, firmwarePage: 2 },
  firmware: { source: 'msx/hb-55_firmware.rom', size: 0x2000, cacheKey: 'msx-hb55-firmware', label: 'Personal Data Bank' },
  biosSource: 'msx/hb-55_basic-bios1.rom',
};

/** Sony HB-55P (Europe, 1984): the PAL twin of the HB-55 — TMS9929A, same 32KB
 *  BIOS slot and 16KB RAM at 0xC000 in slot 0, but a 16KB Personal Data Bank ROM
 *  filling slot 0 page 2 and a second cartridge slot (slot 3) in place of the
 *  expansion bus (MAME `hb55p`, openMSX Sony_HB-55P.xml). */
const HB55P: MsxConfig = {
  model: 'hb-55p',
  ramKB: 16,
  ramBanks: 1,
  hasFDC: false,
  romLabel: 'Sony HB-55P (MSX BASIC 1.0)',
  linesPerFrame: MSX_PAL_LINES,
  frameHz: MSX_PAL_FRAME_HZ,
  tStatesPerFrame: MSX_T_PER_FRAME,
  layout: { ramSlot: 0, ramFirstPage: 3, firmwarePage: 2 },
  firmware: { source: 'msx/hb-55p_firmware.rom', size: 0x4000, cacheKey: 'msx-hb55p-firmware', label: 'Personal Data Bank' },
  biosSource: 'msx/hb-55p_basic-bios1.rom',
};

/** Build the config for an MSX model. */
export function createMsxConfig(model: MsxModel): MsxConfig {
  switch (model) {
    case 'hx-10':
      return HX10;
    case 'hb-55':
      return HB55;
    case 'hb-55p':
      return HB55P;
  }
}
