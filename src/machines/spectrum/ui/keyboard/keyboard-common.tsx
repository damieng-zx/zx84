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

import { For, createSignal, onMount, onCleanup } from 'solid-js';
import { activeSpectrum } from '@/machines/spectrum/ui/active.ts';

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

/** The four legends for each letter key. */
export const LETTERS: Record<string, LetterLegend> = {
  Q: { green: 'SIN', ess: 'ASN', red: '<=', word: 'PLOT' },
  W: { green: 'COS', ess: 'ACS', red: '<>', word: 'DRAW' },
  E: { green: 'TAN', ess: 'ATN', red: '>=', word: 'REM' },
  R: { green: 'INT', ess: 'VERIFY', red: '<', word: 'RUN' },
  T: { green: 'RND', ess: 'MERGE', red: '>', word: 'RAND' },
  Y: { green: 'STR $', ess: '[', red: 'AND', word: 'RETURN' },
  U: { green: 'CHR $', ess: ']', red: 'OR', word: 'IF' },
  I: { green: 'CODE', ess: 'IN', red: 'AT', word: 'INPUT' },
  O: { green: 'PEEK', ess: 'OUT', red: ';', word: 'POKE' },
  P: { green: 'TAB', ess: '©', red: '"', word: 'PRINT' },
  A: { green: 'READ', ess: '~', red: 'STOP', word: 'NEW' },
  S: { green: 'RESTORE', ess: '|', red: 'NOT', word: 'SAVE' },
  D: { green: 'DATA', ess: '\\', red: 'STEP', word: 'DIM' },
  F: { green: 'SGN', ess: '{', red: 'TO', word: 'FOR' },
  G: { green: 'ABS', ess: '}', red: 'THEN', word: 'GOTO' },
  H: { green: 'SQR', ess: 'CIRCLE', red: '↑', word: 'GOSUB' },
  J: { green: 'VAL', ess: 'VAL $', red: '−', word: 'LOAD' },
  K: { green: 'LEN', ess: 'SCREEN $', red: '+', word: 'LIST' },
  L: { green: 'USR', ess: 'ATTR', red: '=', word: 'LET' },
  Z: { green: 'LN', ess: 'BEEP', red: ':', word: 'COPY' },
  X: { green: 'EXP', ess: 'INK', red: '£', word: 'CLEAR' },
  C: { green: 'L PRINT', ess: 'PAPER', red: '?', word: 'CONT' },
  V: { green: 'L LIST', ess: 'FLASH', red: '/', word: 'CLS' },
  B: { green: 'BIN', ess: 'BRIGHT', red: '*', word: 'BORDER' },
  N: { green: 'INKEY $', ess: 'OVER', red: ',', word: 'NEXT' },
  M: { green: 'PI', ess: 'INVERSE', red: '.', word: 'PAUSE' },
};

export interface NumberLegend {
  color?: string;    // ZX colour name (blank on 8 and 9)
  colorCss?: string; // colour to draw the name in
  cmd: string;       // white cursor / EDIT / DELETE command (used by the rubber 48K)
  ext: string;       // extended keyword (DEF FN, FN, …)
  red: string;       // symbol-shift symbol on the key
  block?: number;    // 1..8 block-graphics swatch
}

/** The legends for each number key. */
export const NUMBERS: Record<string, NumberLegend> = {
  '1': { color: 'BLUE',    colorCss: '#2f7bff', cmd: 'EDIT',       ext: 'DEF FN',  red: '!', block: 1 },
  '2': { color: 'RED',     colorCss: '#ff3b3b', cmd: 'CAPS LOCK',  ext: 'FN',      red: '@', block: 2 },
  '3': { color: 'MAGENTA', colorCss: '#d24bd2', cmd: 'TRUE VIDEO', ext: 'LINE',    red: '#', block: 3 },
  '4': { color: 'GREEN',   colorCss: '#33cc55', cmd: 'INV. VIDEO', ext: 'OPEN #',  red: '$', block: 4 },
  '5': { color: 'CYAN',    colorCss: '#2ad2d2', cmd: '←',     ext: 'CLOSE #', red: '%', block: 5 },
  '6': { color: 'YELLOW',  colorCss: '#e6d62e', cmd: '↓',     ext: 'MOVE',    red: '&', block: 6 },
  '7': { color: 'WHITE',   colorCss: '#ffffff', cmd: '↑',     ext: 'ERASE',   red: "'", block: 7 },
  '8': {                                         cmd: '→',     ext: 'POINT',   red: '(', block: 8 },
  '9': {                                         cmd: 'GRAPHICS',   ext: 'CAT',     red: ')' },
  '0': { color: 'BLACK',   colorCss: '#000',    cmd: 'DELETE',     ext: 'FORMAT',  red: '_' },
};

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

const ROWS_RELEASED = (): number[] => [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/**
 * How a sticky key latches:
 *   • 'oneshot' — held until the next ordinary key is pressed, then released
 *     (CAPS SHIFT, SYMBOL SHIFT). Click again to unlatch.
 *   • 'hold'    — stays latched until clicked again; an ordinary key press does
 *     not release it (EXTEND MODE, GRAPH, CAPS LOCK).
 */
export type LatchMode = 'oneshot' | 'hold';

export interface KeyboardController {
  /** True when every matrix bit of the key is currently held (active-low). */
  isDown(positions: [number, number][]): boolean;
  /** Press a key, or toggle a sticky latch. */
  onDown(positions: [number, number][], latch?: LatchMode): void;
  /** Release a momentary key and clear any one-shot latches. */
  onUp(positions: [number, number][], latch?: LatchMode): void;
}

const idOf = (positions: [number, number][]) => positions.map(([r, b]) => `${r},${b}`).join('|');

/**
 * Wires an on-screen keyboard to the live Spectrum:
 *   • ordinary keys are momentary (press on down, release on up);
 *   • CAPS/SYMBOL SHIFT and the mode keys latch (see LatchMode);
 *   • a per-frame poll mirrors the matrix so keys highlight for physical
 *     keystrokes too, not just pointer presses.
 */
/**
 * How long the CAPS+SYMBOL chord is held before release. Long enough for the
 * ROM's 50Hz keyboard scan to register it several times, but well under the
 * auto-repeat delay (REPDEL ≈ 0.7s) so EXTEND MODE toggles exactly once instead
 * of flickering in and out.
 */
const CHORD_PULSE_MS = 120;

export function useKeyboard(): KeyboardController {
  const [matrix, setMatrix] = createSignal<number[]>(ROWS_RELEASED());
  const [latched, setLatched] = createSignal<ReadonlyMap<string, { positions: [number, number][]; hold: boolean }>>(new Map());

  // Shift-chord (CAPS+SYMBOL) bits currently pulsed down, awaiting release.
  let chordTimer: ReturnType<typeof setTimeout> | undefined;
  let chordPositions: [number, number][] = [];
  const releaseChord = () => {
    const kb = activeSpectrum()?.keyboard;
    if (kb) for (const [r, b] of chordPositions) kb.setKey(r, b, false);
    chordPositions = [];
    chordTimer = undefined;
  };

  const isDown = (positions: [number, number][]) =>
    positions.length > 0 && positions.every(([r, b]) => (matrix()[r] & (1 << b)) === 0);

  const onDown = (positions: [number, number][], latch?: LatchMode) => {
    const kb = activeSpectrum()?.keyboard;
    if (!kb) return;
    if (!latch) {
      for (const [r, b] of positions) kb.setKey(r, b, true);
      return;
    }
    const id = idOf(positions);
    const cur = latched();
    // Click an already-latched key again to unlatch it.
    if (cur.has(id)) {
      for (const [r, b] of positions) kb.setKey(r, b, false);
      const next = new Map(cur);
      next.delete(id);
      setLatched(next);
      return;
    }
    // A second one-shot shift while another one-shot is already latched forms a
    // momentary chord (CAPS+SYMBOL → EXTEND MODE). Latching both keeps the chord
    // asserted forever, which makes the ROM auto-repeat the mode toggle (it
    // flickers in and out). Instead pulse both shifts down together briefly: the
    // ROM enters the mode once and remembers it, and we release both shifts.
    if (latch === 'oneshot') {
      const others = [...cur.entries()].filter(([, e]) => !e.hold);
      if (others.length > 0) {
        const next = new Map(cur);
        const chord: [number, number][] = [...positions];
        for (const [oid, e] of others) {
          next.delete(oid);          // drop the persistent latch...
          chord.push(...e.positions); // ...but keep its bit asserted for the pulse
        }
        setLatched(next);
        for (const [r, b] of positions) kb.setKey(r, b, true);
        chordPositions = [...chordPositions, ...chord];
        if (chordTimer) clearTimeout(chordTimer);
        chordTimer = setTimeout(releaseChord, CHORD_PULSE_MS);
        return;
      }
    }
    // Normal latch on.
    for (const [r, b] of positions) kb.setKey(r, b, true);
    const next = new Map(cur);
    next.set(id, { positions, hold: latch === 'hold' });
    setLatched(next);
  };

  const onUp = (positions: [number, number][], latch?: LatchMode) => {
    const kb = activeSpectrum()?.keyboard;
    if (!kb || latch) return; // latched keys toggle on press only
    for (const [r, b] of positions) kb.setKey(r, b, false);
    // Drop one-shot latches (CAPS/SYMBOL SHIFT); leave 'hold' latches asserted.
    const map = latched();
    const next = new Map(map);
    let changed = false;
    for (const [id, entry] of map) {
      if (!entry.hold) {
        for (const [r, b] of entry.positions) kb.setKey(r, b, false);
        next.delete(id);
        changed = true;
      }
    }
    if (changed) setLatched(next);
  };

  onMount(() => {
    let raf = 0;
    const tick = () => {
      const kb = activeSpectrum()?.keyboard;
      if (kb) {
        const r = kb.rows;
        const cur = matrix();
        let changed = false;
        for (let i = 0; i < 8; i++) {
          if (r[i] !== cur[i]) { changed = true; break; }
        }
        if (changed) setMatrix(Array.from(r));
      } else if (matrix().some((b) => b !== 0xff)) {
        setMatrix(ROWS_RELEASED());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  onCleanup(() => { if (chordTimer) clearTimeout(chordTimer); });

  return { isDown, onDown, onUp };
}
