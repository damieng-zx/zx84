/**
 * Sinclair Spectrum model type and classification helpers.
 *
 * The `MachineModel` open union (in `@/models.ts`, the leaf manifest) lets
 * callers pass `currentModel()` directly; every helper here returns false for
 * non-Spectrum models.
 */

import type { MachineModel } from '@/models.ts';

export type SpectrumModel = '16k' | '48k' | '128k' | '+2' | '+2A' | '+3' | 'pentagon128' | 'pentagon512' | 'pentagon1024' | 'scorpion256';

/** Returns true for any 128K-class Spectrum (128K, +2, +2A, +3, the Pentagons, the Scorpion). */
export function is128kClass(m: MachineModel): boolean {
  return m === '128k' || m === '+2' || m === '+2A' || m === '+3' || isPentagonClass(m) || isScorpionClass(m);
}

/** Returns true for the Pentagon family of Russian 128K clones: no contention,
 *  no floating bus, 71680 T-state frame, and a Beta Disk built in. */
export function isPentagonClass(m: MachineModel): boolean {
  return m === 'pentagon128' || m === 'pentagon512' || m === 'pentagon1024';
}

/** Returns true for the Scorpion ZS-256: 256K RAM, a 64K ROM that holds TR-DOS and
 *  a service monitor, port 1FFD paging, no contention, and a Beta Disk built in. */
export function isScorpionClass(m: MachineModel): boolean { return m === 'scorpion256'; }

/** How 7FFD (and 1FFD) form the RAM page number and ROM page: the plain 128K uses
 *  7FFD D0-D2 only; the Pentagon 512 adds D6/D7 as page bits 3/4; the 1024 also
 *  takes D5 as page bit 5 while port EFF7 bit 2 is clear; the Scorpion takes
 *  page bit 3 from 1FFD D4 and the service-ROM select from 1FFD D1. */
export type PagingScheme = 'standard' | 'pentagon512' | 'pentagon1024' | 'scorpion';

export function pagingScheme(m: MachineModel): PagingScheme {
  return m === 'pentagon512' ? 'pentagon512'
    : m === 'pentagon1024' ? 'pentagon1024'
      : m === 'scorpion256' ? 'scorpion'
        : 'standard';
}

/** Number of 16K RAM banks fitted: 8 (128K), 16 (Scorpion 256K), 32 (Pentagon 512),
 *  64 (Pentagon 1024). */
export function ramBankCountFor(m: MachineModel): number {
  return m === 'pentagon512' ? 32 : m === 'pentagon1024' ? 64 : m === 'scorpion256' ? 16 : 8;
}

/** Returns true for models that ship with a Beta Disk (TR-DOS) interface fitted
 *  on the board, so it is always present rather than a Hardware-pane option. */
export function hasBuiltinBetaDisk(m: MachineModel): boolean { return isPentagonClass(m) || isScorpionClass(m); }

/** Returns true when the built-in Beta Disk's TR-DOS is a page of the machine's
 *  own system ROM (the Scorpion's ROM page 3) rather than a separate ROM image. */
export function betaRomInSystemRom(m: MachineModel): boolean { return isScorpionClass(m); }

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
 * already have a built-in FDC and use special paging) and the Pentagon, which
 * has one built in (see hasBuiltinBetaDisk). The classic setup is a Beta Disk
 * on a 48K.
 */
export function isBetaDiskCapable(m: MachineModel): boolean {
  return m === '48k' || m === '128k' || m === '+2' || hasBuiltinBetaDisk(m);
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
  if (m === '128k' || m === '+2' || isPentagonClass(m)) return 2;
  if (m === '+2A' || m === '+3' || isScorpionClass(m)) return 4;
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

/** A system-ROM slot index within a multi-slot model. 0-3 index the Spectrum's
 *  16K pages (see romPageSlotCount); index 4 is only reached by the MTX's five
 *  8K firmware slots, which reuse this same override machinery. */
export type RomPage = 0 | 1 | 2 | 3 | 4;

/** +2A/+3 default page names, in page-index order (0-3) — see
 *  romPageSlotCount and the 1FFD/7FFD ROM-select bit table in memory.ts. */
const PLUS3_PAGE_NAMES = ['128K Editor', '128K Syntax Checker', '+3DOS', '48K BASIC'];

/** Scorpion ZS-256 page names, in page-index order (contents from the v2.92 ROM
 *  image). Pages 0/1 are chosen by 7FFD D4, page 2 by 1FFD D1; page 3 (TR-DOS) is
 *  mapped in by the Beta Disk's automatic paging, not by a port. */
const SCORPION_PAGE_NAMES = ['Scorpion 128K', '48K BASIC', 'Service Monitor', 'TR-DOS'];

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
  if (isScorpionClass(model)) return SCORPION_PAGE_NAMES[page];
  const maker = model === '+2' ? 'Amstrad' : isPentagonClass(model) ? 'Pentagon' : 'Sinclair';
  return page === 0 ? `${maker} 128K BASIC` : `${maker} 48K BASIC`;
}
