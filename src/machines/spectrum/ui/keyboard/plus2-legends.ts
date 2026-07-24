/**
 * Legend rules for the grey ZX Spectrum +2 keyboard (1986, Amstrad).
 *
 * The grey +2 reuses the 128K/+ "toastrack" key layout but strips almost every
 * secondary legend from the caps. Only three BASIC keywords survive — the ones
 * you need at the tape loader prompt (`RUN`, `LOAD ""`, `LOAD "" CODE`) — and a
 * red symbol-shift token is printed only where it is a single printable glyph
 * that does not already have its own dedicated key.
 *
 * These are pure data/predicates (no JSX) so they can be unit-tested directly;
 * the keyboard components (KeyboardPlus / KeyboardPane) consume them.
 */

import type { MachineModel } from '@/models.ts';

/**
 * Symbol-shift glyphs that have their own dedicated key on the + / +2 layout
 * (the small keys around SPACE and SYMBOL SHIFT). Their red token is therefore
 * not reprinted on the letter key — e.g. `;` lives on its own key, so O is bare.
 */
export const PLUS2_DEDICATED_SYMBOLS: ReadonlySet<string> = new Set([';', '"', ',', '.']);

/**
 * The white keywords the grey +2 keeps on its letter caps, keyed by main glyph.
 * RUN and LOAD are the K-mode keywords on R and J; CODE is the extended-mode
 * keyword on I. Together they spell the tape-start tokens: RUN, LOAD "" [CODE].
 */
export const PLUS2_KEYWORDS: Readonly<Record<string, string>> = { R: 'RUN', I: 'CODE', J: 'LOAD' };

/**
 * True when the grey +2 prints this red symbol-shift token on its key: only a
 * single-character symbol that is not already on a dedicated key. Multi-char
 * tokens (`<=`, words like AND/STOP) and the dedicated symbols are dropped.
 */
export function plus2KeepsRed(red: string | undefined): boolean {
  if (!red) return false;
  return [...red].length === 1 && !PLUS2_DEDICATED_SYMBOLS.has(red);
}

/**
 * Which sparse on-screen keyboard face a model uses, or null for the full
 * 128K/+ toastrack. The +2 and the Amstrad +2A/+3 share the same stripped-down
 * layout; they differ only in case colour ('grey2' vs the near-black 'amstrad').
 * The face never switches with the ROM — the real keyboards don't change between
 * 48K and 128K modes.
 */
export function sparseKeyboardFace(model: MachineModel): 'grey2' | 'amstrad' | null {
  if (model === '+2') return 'grey2';
  if (model === '+2A' || model === '+3') return 'amstrad';
  return null;
}

/**
 * Width (in key units) of a key on the +2/+2A/+3 sparse face. Every alphanumeric
 * and most command keys are a uniform 1u; the rest retain their measured
 * quarter-unit widths. Scene geometry places the caps directly rather than
 * stretching rows to fill. `variant`/`label` come from the shared key definition
 * (see KeyboardPlus); `fallback` is used for the 1u keys.
 *
 *   1u   : alphanumerics, TRUE/INV VIDEO, GRAPH, EDIT, CAPS LOCK, SYMBOL SHIFT,
 *          the dedicated symbol/arrow keys, and the ENTER stem.
 *   1.5u : DELETE, BREAK        1.75u: EXTEND MODE
 *   2.25u: CAPS SHIFT           4.5u: SPACE
 */
export function plus2KeyWidth(variant: string, label: string | undefined, fallback: number): number {
  switch (variant) {
    case 'enter': return 1;          // stem cell (row 2)
    case 'space': return 4.5;
    case 'fn':
      if (label === 'DELETE' || label === 'BREAK') return 1.5;
      if (label === 'EXTEND\nMODE') return 1.75;
      return 1; // TRUE/INV VIDEO, GRAPH, EDIT, CAPS LOCK
    case 'mod':
      return label?.startsWith('CAPS') ? 2.25 : 1; // CAPS SHIFT wide; SYMBOL SHIFT 1u
    default:
      return fallback; // letters, numbers, dedicated symbol/arrow keys → 1u
  }
}
