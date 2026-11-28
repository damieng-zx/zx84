/**
 * Shared plumbing for the on-screen keyboards (rubber 48K and the Spectrum +
 * / 128K layout).
 *
 * Holds the ZX keyboard-matrix positions, the per-key legend tables (the four
 * Sinclair legends: green extended keyword, red extended+symbol-shift keyword,
 * red symbol-shift token, and white K-mode keyword), and `useKeyboard()` — the
 * interaction controller that drives `spectrum.keyboard` and mirrors the live
 * matrix for highlighting.
 */

import { For } from 'solid-js';
import { useLatchKeyboard } from '@/ui/keyboard/latch-keyboard.ts';
import type { LatchMode } from '@/ui/keyboard/latch-keyboard.ts';
import { activeSpectrum } from '@/machines/spectrum/ui/active.ts';
import type { SpectrumKeyboard } from '@/machines/spectrum/keyboard.ts';

/** ZX keyboard-matrix [row, bit] for each key glyph. */
export const POS: Record<string, [number, number]> = {
  '1': [3, 0], '2': [3, 1], '3': [3, 2], '4': [3, 3], '5': [3, 4],
  '6': [4, 4], '7': [4, 3], '8': [4, 2], '9': [4, 1], '0': [4, 0],
  Q: [2, 0], W: [2, 1], E: [2, 2], R: [2, 3], T: [2, 4],
  Y: [5, 4], U: [5, 3], I: [5, 2], O: [5, 1], P: [5, 0],
  A: [1, 0], S: [1, 1], D: [1, 2], F: [1, 3], G: [1, 4],
  H: [6, 4], J: [6, 3], K: [6, 2], L: [6, 1],
  Z: [0, 1], X: [0, 2], C: [0, 3], V: [0, 4],
  B: [7, 4], N: [7, 3], M: [7, 2],
  ENTER: [6, 0], SPACE: [7, 0], CAPS: [0, 0], SYM: [7, 1],
};

/** CAPS SHIFT and SYMBOL SHIFT matrix bits — the two modifiers. */
export const CS: [number, number] = [0, 0];
export const SS: [number, number] = [7, 1];

export interface LetterLegend {
  green: string; // extended-mode keyword (CAPS+SYM then key)
  ess: string;   // extended + symbol-shift keyword
  red: string;   // symbol-shift token printed on the key
  word: string;  // K-mode keyword printed on the key
}

// Legacy UK legend constants — retained for backward compatibility.
// New code should use lettersFor()/numbersFor() from ./legends.ts.
import { lettersFor as _lettersFor, numbersFor as _numbersFor } from './legends.ts';

/** The four legends for each letter key (UK locale). */
export const LETTERS: Record<string, LetterLegend> = _lettersFor('uk');

export { lettersFor, numbersFor } from './legends.ts';

export interface NumberLegend {
  color?: string;    // ZX colour name (blank on 8 and 9)
  colorCss?: string; // colour to draw the name in
  cmd: string;       // white cursor / EDIT / DELETE command (used by the rubber 48K)
  ext: string;       // extended keyword (DEF FN, FN, …)
  red: string;       // symbol-shift symbol on the key
  block?: number;    // 1..8 block-graphics swatch
}

/** The legends for each number key (UK locale). */
export const NUMBERS: Record<string, NumberLegend> = _numbersFor('uk');

// Block-graphics swatches printed on number keys 1–8: which of the four
// quadrants [top-left, top-right, bottom-left, bottom-right] are filled. Keys
// 1–4 are the inverse (all but one quadrant) of keys 7–4; key 8 is the empty
// outlined block (CHR$ 128).
export const BLOCKS: Record<number, [boolean, boolean, boolean, boolean]> = {
  1: [true, false, true, true],
  2: [false, true, true, true],
  3: [false, false, true, true],
  4: [true, true, true, false],
  5: [true, false, true, false],
  6: [false, true, true, false],
  7: [false, false, true, false],
  8: [false, false, false, false],
};

/** A 2×2 block-graphics swatch. `class` lets each keyboard position it; an
 *  all-empty pattern (key 8 / CHR$ 128) draws as a bare outlined box. */
export function Block(props: { n: number; class?: string }) {
  const quads = () => BLOCKS[props.n];
  return (
    <span class={props.class ?? 'k-block'} classList={{ 'block-empty': quads().every((q) => !q) }}>
      <For each={quads()}>{(on) => <i classList={{ on }} />}</For>
    </span>
  );
}

export interface KeyboardController {
  /** True when every matrix bit of the key is currently held (active-low). */
  isDown(positions: [number, number][]): boolean;
  /** Press a key, or toggle a sticky latch. */
  onDown(positions: [number, number][], latch?: LatchMode): void;
  /** Release a momentary key and clear any one-shot latches. */
  onUp(positions: [number, number][], latch?: LatchMode): void;
}

/**
 * Wires an on-screen keyboard to the live Spectrum:
 *   - ordinary keys are momentary (press on down, release on up);
 *   - CAPS/SYMBOL SHIFT and the mode keys latch (see LatchMode);
 *   - a per-frame poll mirrors the matrix so keys highlight for physical
 *     keystrokes too, not just pointer presses.
 *
 * The latch itself is the shared one in `@/ui/keyboard/latch-keyboard.ts`.
 */
export function useKeyboard(): KeyboardController {
  return useLatchKeyboard<SpectrumKeyboard>({
    keyboard: () => activeSpectrum()?.keyboard ?? null,
    rows: (kb) => kb.rows,
    setKey: (kb, row, bit, down) => kb.setKey(row, bit, down),
    rowCount: 8,
    released: 0xff,
  });
}

export type { LatchMode };