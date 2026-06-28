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
 * True when the on-screen keyboard should use the sparse grey +2 rendering — the
 * +2 model, always. (The real +2 keyboard is the same whether you're in 48K or
 * 128K mode, so we don't switch faces with the ROM.)
 */
export function plus2UsesSparse(model: MachineModel): boolean {
  return model === '+2';
}

/**
 * Width (in key units) of a key on the grey +2 face. Every alphanumeric and most
 * command keys are a uniform 1u; the rest are sized so each row totals the same
 * 13.25u, giving a true fixed grid (the keys are laid out at a fixed width, not
 * stretched to fill — see the .kbd-plus--grey2 rules). `variant`/`label` come
 * from the shared key definition (see KeyboardPlus); `fallback` is used for the
 * keys that are 1u in both faces.
 *
 *   1u   : alphanumerics, TRUE/INV VIDEO, GRAPH, EDIT, CAPS LOCK, SYMBOL SHIFT,
 *          the dedicated symbol/arrow keys, and the ENTER top.
 *   1.25u: DELETE, BREAK            1.7u: EXTEND MODE        2.125u: CAPS SHIFT
 *   1.55u: ENTER base (the L's foot — the leftover under the 1u ENTER top)
 *   4.25u: SPACE (the leftover across the bottom row)
 */
export function plus2KeyWidth(variant: string, label: string | undefined, fallback: number): number {
  switch (variant) {
    case 'enter-top': return 1;
    case 'enter-bottom': return 1.55;
    case 'space': return 4.25;
    case 'fn':
      if (label === 'DELETE' || label === 'BREAK') return 1.25;
      if (label === 'EXTEND\nMODE') return 1.7;
      return 1; // TRUE/INV VIDEO, GRAPH, EDIT, CAPS LOCK
    case 'mod':
      return label?.startsWith('CAPS') ? 2.125 : 1; // CAPS SHIFT wide; SYMBOL SHIFT 1u
    default:
      return fallback; // letters, numbers, dedicated symbol/arrow keys → 1u
  }
}
