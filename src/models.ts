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

// ── Per-family classification helpers (re-exported from each machine folder) ─
export {
  is128kClass,
  is16K,
  isPlus2AClass,
  isPlus3,
  isPlusDCapable,
  isInterface1Capable,
  isBetaDiskCapable,
  romPageSlotCount,
  isInterface2Capable,
  defaultRomPageLabel,
  type RomPage,
} from '@/machines/spectrum/models.ts';
export { isCpcModel, cpcHasDisk, cpcHasTape, cpcIsPlusClass } from '@/machines/cpc/models.ts';
export { isEinsteinModel } from '@/machines/einstein/models.ts';
export { isMsxModel } from '@/machines/msx/models.ts';
export { isZx8xModel } from '@/machines/zx8x/models.ts';
export { isMtxModel } from '@/machines/mtx/models.ts';

// ── The open union ─────────────────────────────────────────────────────────
import type { SpectrumModel } from '@/machines/spectrum/models.ts';
import type { CpcModel } from '@/machines/cpc/models.ts';
import type { EinsteinModel } from '@/machines/einstein/models.ts';
import type { MsxModel } from '@/machines/msx/models.ts';
import type { Zx8xModel } from '@/machines/zx8x/models.ts';
import type { MtxModel } from '@/machines/mtx/models.ts';

/** Any machine ZX84 can emulate. */
export type MachineModel =
  | SpectrumModel
  | CpcModel
  | EinsteinModel
  | MsxModel
  | Zx8xModel
  | MtxModel;
