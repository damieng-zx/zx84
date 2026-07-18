/**
 * Sinclair Spectrum model type and classification helpers.
 *
 * The `MachineModel` open union (in `@/models.ts`, the leaf manifest) lets
 * callers pass `currentModel()` directly; every helper here returns false for
 * non-Spectrum models.
 */

import type { MachineModel } from '@/models.ts';

export type SpectrumModel = '16k' | '48k' | '128k' | '+2' | '+2A' | '+3';

/** Returns true for any 128K-class Spectrum (128K, +2, +2A, +3). */
export function is128kClass(m: MachineModel): boolean {
  return m === '128k' || m === '+2' || m === '+2A' || m === '+3';
}

/** Returns true for the issue 1/2 16K Spectrum (no upper 32KB of RAM). */
export function is16K(m: MachineModel): boolean { return m === '16k'; }

/** Returns true for +2A/+3 class (Amstrad gate array with 0x1FFD port, 4 ROM pages). */
export function isPlus2AClass(m: MachineModel): boolean { return m === '+2A' || m === '+3'; }

/** Returns true for +3 (has uPD765A FDC). */
export function isPlus3(m: MachineModel): boolean { return m === '+3'; }

/**
 * Returns true for models the MGT +D interface can attach to: the plain
 * 48K/128K/+2. Excluded: the 16K (too little RAM for G+DOS) and the +2A/+3
 * (Amstrad special paging conflicts, and they already have a built-in FDC).
 */
export function isPlusDCapable(m: MachineModel): boolean {
  return m === '48k' || m === '128k' || m === '+2';
}

/**
 * Returns true for models the ZX Interface 1 can attach to: the Ferranti-ULA
 * 48K/128K/+2. Excluded: the 16K and the Amstrad +2A/+3, whose redesigned edge
 * connector the IF1 is not electrically compatible with.
 */
export function isInterface1Capable(m: MachineModel): boolean {
  return m === '48k' || m === '128k' || m === '+2';
}

/**
 * Returns true for models the Beta Disk interface (TR-DOS) can attach to: the
 * Ferranti-ULA 48K/128K/+2. Excluded: the 16K and the Amstrad +2A/+3 (which
 * already have a built-in FDC and use special paging). The classic setup is a
 * Beta Disk on a 48K.
 */
export function isBetaDiskCapable(m: MachineModel): boolean {
  return m === '48k' || m === '128k' || m === '+2';
}

/**
 * Returns the number of independently loadable/ejectable 16K ROM pages the
 * ROM pane splits this model's system ROM into, instead of showing it as one
 * combined "System ROM" slot:
 *  - 128K/+2 → 2 pages: page 0 the 128K editor/menu ROM, page 1 the 48K
 *    BASIC ROM (see SpectrumMemory.isBasicRomActive).
 *  - +2A/+3 → 4 pages, selected by 1FFD bit 2 / 7FFD bit 4 (see
 *    memory.ts bankSwitch/bankSwitch1FFD): page 0 the 128K editor/menu/
 *    self-test ROM, page 1 the 128K syntax checker, page 2 +3DOS, page 3 the
 *    48K BASIC ROM.
 *  - every other model → 0 (single combined "System ROM" slot).
 */
export function romPageSlotCount(m: MachineModel): 0 | 2 | 4 {
  if (m === '128k' || m === '+2') return 2;
  if (m === '+2A' || m === '+3') return 4;
  return 0;
}

/**
 * Returns true for models the ZX Interface 2 ROM cartridge slot fits: the
 * 16K and 48K Spectrum. Excluded: 128K-class machines, whose own ROM-paging
 * scheme the cartridge's permanent /ROMCS-disable would conflict with — the
 * real Interface 2 predates the 128K and was only ever sold for the 16K/48K.
 */
export function isInterface2Capable(m: MachineModel): boolean {
  return m === '16k' || m === '48k';
}

/** A 16K ROM page index within a multi-page model (see romPageSlotCount). */
export type RomPage = 0 | 1 | 2 | 3;

/** +2A/+3 default page names, in page-index order (0-3) — see
 *  romPageSlotCount and the 1FFD/7FFD ROM-select bit table in memory.ts. */
const PLUS3_PAGE_NAMES = ['128K Editor', '128K Syntax Checker', '+3DOS', '48K BASIC'];

/** Label for a default (non-overridden) 16K page of a multi-page model
 *  (128K/+2/+2A/+3 — see romPageSlotCount).
 *  - 128K/+2: page 0 the 128K editor/menu ROM, page 1 the 48K-compatible
 *    BASIC ROM. Named by author: Sinclair wrote the 128K's ROM set; the grey
 *    +2 shipped under Amstrad ownership with its own (different) ROM despite
 *    the shared 128K architecture.
 *  - +2A/+3: the four real ROM names (editor, syntax checker, +3DOS, 48K
 *    BASIC) — same for both, since the +2A reuses the +3's ROM set. */
export function defaultRomPageLabel(model: MachineModel, page: RomPage): string {
  if (model === '+2A' || model === '+3') return PLUS3_PAGE_NAMES[page];
  const maker = model === '+2' ? 'Amstrad' : 'Sinclair';
  return page === 0 ? `${maker} 128K BASIC` : `${maker} 48K BASIC`;
}
