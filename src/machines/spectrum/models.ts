/**
 * Sinclair Spectrum model type and classification helpers.
 *
 * The `MachineModel` open union (in `@/models.ts`, the leaf manifest) lets
 * callers pass `currentModel()` directly; every helper here returns false for
 * non-Spectrum models.
 */

import type { MachineModel } from '@/models.ts';

export type SpectrumModel = 'zx16k' | 'zx48k' | 'zx128k' | 'zx128kplus2' | 'zx128kplus2a' | 'zx128kplus3';

/** The ids the Spectrum models carried before they were unified under a `zx`
 *  prefix, paired with their current id. Saved settings, stored ROM overrides
 *  and old `?model=` links still use these, so they are migrated rather than
 *  dropped. Exact case: they are also the old storage-key spellings. */
export const LEGACY_SPECTRUM_IDS: readonly (readonly [legacy: string, current: SpectrumModel])[] = [
  ['16k', 'zx16k'], ['48k', 'zx48k'], ['128k', 'zx128k'],
  ['+2', 'zx128kplus2'], ['+2A', 'zx128kplus2a'], ['+3', 'zx128kplus3'],
];

/** Resolve a legacy Spectrum id (`48k`, `+2A`, URL spellings `plus2a`, any
 *  case) to its current id, or null when `raw` is not a legacy id. */
export function legacySpectrumModel(raw: string): SpectrumModel | null {
  const wanted = raw.trim().toLowerCase().replace(/^plus/, '+');
  return LEGACY_SPECTRUM_IDS.find(([legacy]) => legacy.toLowerCase() === wanted)?.[1] ?? null;
}

/** Returns true for any 128K-class Spectrum (128K, +2, +2A, +3). */
export function is128kClass(m: MachineModel): boolean {
  return m === 'zx128k' || m === 'zx128kplus2' || m === 'zx128kplus2a' || m === 'zx128kplus3';
}

/** Returns true for the issue 1/2 16K Spectrum (no upper 32KB of RAM). */
export function is16K(m: MachineModel): boolean { return m === 'zx16k'; }

/** Returns true for +2A/+3 class (Amstrad gate array with 0x1FFD port, 4 ROM pages). */
export function isPlus2AClass(m: MachineModel): boolean { return m === 'zx128kplus2a' || m === 'zx128kplus3'; }

/** Returns true for +3 (has uPD765A FDC). */
export function isPlus3(m: MachineModel): boolean { return m === 'zx128kplus3'; }

/**
 * Returns true for models the MGT +D interface can attach to: the plain
 * 48K/128K/+2. Excluded: the 16K (too little RAM for G+DOS) and the +2A/+3
 * (Amstrad special paging conflicts, and they already have a built-in FDC).
 */
export function isPlusDCapable(m: MachineModel): boolean {
  return m === 'zx48k' || m === 'zx128k' || m === 'zx128kplus2';
}

/**
 * Returns true for models the ZX Interface 1 can attach to: the Ferranti-ULA
 * 48K/128K/+2. Excluded: the 16K and the Amstrad +2A/+3, whose redesigned edge
 * connector the IF1 is not electrically compatible with.
 */
export function isInterface1Capable(m: MachineModel): boolean {
  return m === 'zx48k' || m === 'zx128k' || m === 'zx128kplus2';
}

/**
 * Returns true for models the Beta Disk interface (TR-DOS) can attach to: the
 * Ferranti-ULA 48K/128K/+2. Excluded: the 16K and the Amstrad +2A/+3 (which
 * already have a built-in FDC and use special paging). The classic setup is a
 * Beta Disk on a 48K.
 */
export function isBetaDiskCapable(m: MachineModel): boolean {
  return m === 'zx48k' || m === 'zx128k' || m === 'zx128kplus2';
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
  if (m === 'zx128k' || m === 'zx128kplus2') return 2;
  if (m === 'zx128kplus2a' || m === 'zx128kplus3') return 4;
  return 0;
}

/**
 * Returns true for models the ZX Interface 2 ROM cartridge slot fits: the
 * 16K and 48K Spectrum. Excluded: 128K-class machines, whose own ROM-paging
 * scheme the cartridge's permanent /ROMCS-disable would conflict with — the
 * real Interface 2 predates the 128K and was only ever sold for the 16K/48K.
 */
export function isInterface2Capable(m: MachineModel): boolean {
  return m === 'zx16k' || m === 'zx48k';
}

/** A system-ROM slot index within a multi-slot model. 0-3 index the Spectrum's
 *  16K pages (see romPageSlotCount); index 4 is only reached by the MTX's five
 *  8K firmware slots, which reuse this same override machinery. */
export type RomPage = 0 | 1 | 2 | 3 | 4;

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
  if (model === 'zx128kplus2a' || model === 'zx128kplus3') return PLUS3_PAGE_NAMES[page];
  const maker = model === 'zx128kplus2' ? 'Amstrad' : 'Sinclair';
  return page === 0 ? `${maker} 128K BASIC` : `${maker} 48K BASIC`;
}
