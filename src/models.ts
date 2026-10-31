/**
 * Machine model manifest — the leaf catalog of every model ZX84 can emulate.
 *
 * This file owns only two machine-spanning things (a parts catalog, not logic):
 *  1. the open `MachineModel` union, and
 *  2. re-exports of each family's model type + classification helpers.
 *
 * The per-family model types and helpers themselves live inside their machine
 * folder (`machines/<name>/models.ts`); they are re-exported here so that
 * model-agnostic plumbing and UI (which must not import a machine folder
 * directly) can reach them through this neutral manifest. Adding a machine adds
 * one import + one union member here and nothing else in the tree.
 */

// ── Per-family model types (re-exported from each machine folder) ──────────
export type { SpectrumModel } from '@/machines/spectrum/models.ts';
export type { CpcModel } from '@/machines/cpc/models.ts';
export type { EinsteinModel } from '@/machines/einstein/models.ts';
export type { MsxModel } from '@/machines/msx/models.ts';
export type { Zx8xModel } from '@/machines/zx8x/models.ts';
export type { MtxModel } from '@/machines/mtx/models.ts';
export type { LynxModel } from '@/machines/lynx/models.ts';
export type { JupiterAceModel } from '@/machines/jupiter-ace/models.ts';
export type { PcwModel } from '@/machines/pcw/models.ts';
export type { BbcModel } from '@/machines/bbc/models.ts';
export type { ElectronModel } from '@/machines/electron/models.ts';
export type { Apple2Model } from '@/machines/apple2/models.ts';
export type { EnterpriseModel } from '@/machines/enterprise/models.ts';
export type { AtariModel } from '@/machines/atari/models.ts';
export type { C64Model } from '@/machines/c64/models.ts';
export type { NewBrainModel } from '@/machines/newbrain/models.ts';

// ── Per-family classification helpers (re-exported from each machine folder) ─
export {
  is128kClass,
  is16K,
  isPlus2AClass,
  isPlus3,
  isPlusDCapable,
  isInterface1Capable,
  isUspeechCapable,
  isBetaDiskCapable,
  isPentagonClass,
  isScorpionClass,
  hasBuiltinBetaDisk,
  betaRomInSystemRom,
  isInterface2Capable,
  LEGACY_SPECTRUM_IDS,
  legacySpectrumModel,
  type RomPage,
} from '@/machines/spectrum/models.ts';
export { isCpcModel, cpcHasDisk, cpcHasTape, cpcIsPlusClass } from '@/machines/cpc/models.ts';
export { isEinsteinModel } from '@/machines/einstein/models.ts';
export { isMsxModel } from '@/machines/msx/models.ts';
export { isZx8xModel } from '@/machines/zx8x/models.ts';
export { isMtxModel } from '@/machines/mtx/models.ts';
export { isLynxModel } from '@/machines/lynx/models.ts';
export { isJupiterAceModel } from '@/machines/jupiter-ace/models.ts';
export { isPcwModel } from '@/machines/pcw/models.ts';
export { isBbcModel } from '@/machines/bbc/models.ts';
export { isElectronModel } from '@/machines/electron/models.ts';
export { isApple2Model } from '@/machines/apple2/models.ts';
export { isEnterpriseModel } from '@/machines/enterprise/models.ts';
export { isAtariModel } from '@/machines/atari/models.ts';
export { isC64Model } from '@/machines/c64/models.ts';
export { isNewBrainModel } from '@/machines/newbrain/models.ts';

// ── System-ROM slot geometry (dispatches per family) ───────────────────────
//
// The Spectrum owns the multi-page ROM-slot machinery (2/4 × 16K pages). The
// MTX reuses it with a different shape: five 8K firmware slots. These wrappers
// keep the neutral call sites (shell ROM plumbing, ROM pane) family-blind —
// they ask models.ts, not a machine folder.
import {
  romPageSlotCount as spectrumRomPageSlotCount,
  defaultRomPageLabel as spectrumDefaultRomPageLabel,
  type RomPage as RomSlotIndex,
} from '@/machines/spectrum/models.ts';
import {
  isMtxModel as isMtx, MTX_ROM_SLOT_SIZE, MTX_ROM_SLOT_LABELS,
} from '@/machines/mtx/models.ts';
import {
  isLynxModel as isLynx, LYNX_ROM_SLOT_SIZE, lynxRomSlotLabels,
} from '@/machines/lynx/models.ts';
import {
  isC64Model as isC64, C64_ROM_SLOT_SIZE, C64_ROM_SLOT_LABELS,
} from '@/machines/c64/models.ts';
import { BANK_SIZE } from '@/utils/bank-size.ts';

/** Number of independently-overridable system-ROM slots for a model
 *  (0 = one combined image). MTX → 5, Lynx → 2/4, C64 → 3 (8K stride);
 *  Spectrum → 0/2/4 (16K each). */
export function romPageSlotCount(model: MachineModel): number {
  if (isMtx(model)) return MTX_ROM_SLOT_LABELS.length;
  if (isLynx(model)) return lynxRomSlotLabels(model).length;
  if (isC64(model)) return C64_ROM_SLOT_LABELS.length;
  return spectrumRomPageSlotCount(model);
}

/** Byte size of one system-ROM slot for a model — 8K on the MTX, Lynx and
 *  C64, 16K elsewhere. Used to splice per-slot overrides back onto the
 *  concatenated ROM. */
export function romSlotSize(model: MachineModel): number {
  if (isMtx(model)) return MTX_ROM_SLOT_SIZE;
  if (isLynx(model)) return LYNX_ROM_SLOT_SIZE;
  if (isC64(model)) return C64_ROM_SLOT_SIZE;
  return BANK_SIZE;
}

/** Label for a default (non-overridden) system-ROM slot of a multi-slot model. */
export function defaultRomPageLabel(model: MachineModel, page: RomSlotIndex): string {
  if (isMtx(model)) return MTX_ROM_SLOT_LABELS[page];
  if (isLynx(model)) return lynxRomSlotLabels(model)[page] ?? '';
  if (isC64(model)) return (C64_ROM_SLOT_LABELS as readonly string[])[page] ?? '';
  return spectrumDefaultRomPageLabel(model, page);
}

// ── The open union ─────────────────────────────────────────────────────────
import type { SpectrumModel } from '@/machines/spectrum/models.ts';
import type { CpcModel } from '@/machines/cpc/models.ts';
import type { EinsteinModel } from '@/machines/einstein/models.ts';
import type { MsxModel } from '@/machines/msx/models.ts';
import type { Zx8xModel } from '@/machines/zx8x/models.ts';
import type { MtxModel } from '@/machines/mtx/models.ts';
import type { LynxModel } from '@/machines/lynx/models.ts';
import type { JupiterAceModel } from '@/machines/jupiter-ace/models.ts';
import type { PcwModel } from '@/machines/pcw/models.ts';
import type { BbcModel } from '@/machines/bbc/models.ts';
import type { ElectronModel } from '@/machines/electron/models.ts';
import type { Apple2Model } from '@/machines/apple2/models.ts';
import type { Apple1Model } from '@/machines/apple1/models.ts';
import type { EnterpriseModel } from '@/machines/enterprise/models.ts';
import type { AtariModel } from '@/machines/atari/models.ts';
import type { C64Model } from '@/machines/c64/models.ts';
import type { NewBrainModel } from '@/machines/newbrain/models.ts';

/** Any machine ZX84 can emulate. */
export type MachineModel =
  | SpectrumModel
  | CpcModel
  | EinsteinModel
  | MsxModel
  | Zx8xModel
  | MtxModel
  | LynxModel
  | JupiterAceModel
  | PcwModel
  | BbcModel
  | ElectronModel
  | Apple2Model
  | Apple1Model
  | EnterpriseModel
  | AtariModel
  | C64Model
  | NewBrainModel;
