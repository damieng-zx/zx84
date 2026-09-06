/**
 * The SAM Coupé's 69 keys: what each one is called, what it prints, and which
 * matrix position it closes.
 *
 * Legends are read off a photograph of a real machine and cross-checked
 * against `sam-keyboard.ts`'s `CHAR_MAP` (SimCoupe's `asSamKeys`), which is
 * what actually decides where a typed symbol lands. Where the two could
 * disagree the table wins, because it is the one the emulator obeys:
 *
 *   - `[` and `]` are SYMBOL+R and SYMBOL+T, not on E and R;
 *   - `{` and `}` are SYMBOL+F and SYMBOL+G — at photo resolution those
 *     braces read as ordinary parentheses;
 *   - H's legend is drawn as an up arrow but the character is `^`.
 *
 * Two legends are printed that the emulator cannot type, because they are on
 * the real keycaps: `©` (SYMBOL+") and the `↑` on H. Neither appears in
 * `CHAR_MAP` — no common host layout produces them.
 *
 * The count is a useful check: rows 0-7 hold eight keys each and row 8 holds
 * five, which is the 69 the Technical Manual quotes. There are more CAPS than
 * switches — SHIFT, SYMBOL and the full stop each have two — so the table is
 * keyed by cap id and several ids share a cell.
 */

/** A matrix position, as [row, bit]. */
export type SamCell = readonly [number, number];

export interface SamKey {
  /** Stable id, used by the geometry to place it. */
  readonly id: string;
  /** Main legend on the cap. A word (SHIFT, DELETE) styles smaller. */
  readonly main: string;
  /** Secondary legend printed ABOVE the main one, as on the real caps. */
  readonly top?: string;
  /** Matrix position this cap closes. */
  readonly cell: SamCell;
  /** Darker grey-beige cap: the modifiers and editing keys. */
  readonly dark?: boolean;
}

/** Every key, by id. Two caps share a cell in each SHIFT/SYMBOL pair. */
export const SAM_KEYS: readonly SamKey[] = [
  // ── Row 3 of the matrix: digits 1-5, ESC, TAB, CAPS ──
  { id: 'esc', main: 'ESC', cell: [3, 5], dark: true },
  { id: '1', main: '1', top: '!', cell: [3, 0] },
  { id: '2', main: '2', top: '@', cell: [3, 1] },
  { id: '3', main: '3', top: '#', cell: [3, 2] },
  { id: '4', main: '4', top: '$', cell: [3, 3] },
  { id: '5', main: '5', top: '%', cell: [3, 4] },
  { id: 'tab', main: 'TAB', cell: [3, 6], dark: true },
  { id: 'caps', main: 'CAPS', cell: [3, 7], dark: true },

  // ── Row 4: digits 6-0, MINUS, PLUS, DELETE ──
  { id: '6', main: '6', top: '&', cell: [4, 4] },
  { id: '7', main: '7', top: '’', cell: [4, 3] },
  { id: '8', main: '8', top: '(', cell: [4, 2] },
  { id: '9', main: '9', top: ')', cell: [4, 1] },
  { id: '0', main: '0', top: '~', cell: [4, 0] },
  { id: 'minus', main: '−', top: '/', cell: [4, 5] },
  { id: 'plus', main: '+', top: '*', cell: [4, 6] },
  { id: 'delete', main: 'DELETE', cell: [4, 7], dark: true },

  // ── Row 2: Q W E R T, F7-F9 ──
  { id: 'q', main: 'Q', top: '<', cell: [2, 0] },
  { id: 'w', main: 'W', top: '>', cell: [2, 1] },
  { id: 'e', main: 'E', cell: [2, 2] },
  { id: 'r', main: 'R', top: '[', cell: [2, 3] },
  { id: 't', main: 'T', top: ']', cell: [2, 4] },
  { id: 'f7', main: 'F7', cell: [2, 5] },
  { id: 'f8', main: 'F8', cell: [2, 6] },
  { id: 'f9', main: 'F9', cell: [2, 7] },

  // ── Row 5: P O I U Y, EQUALS, QUOTES, F0 ──
  { id: 'y', main: 'Y', cell: [5, 4] },
  { id: 'u', main: 'U', cell: [5, 3] },
  { id: 'i', main: 'I', cell: [5, 2] },
  { id: 'o', main: 'O', cell: [5, 1] },
  { id: 'p', main: 'P', cell: [5, 0] },
  { id: 'equals', main: '=', top: '_', cell: [5, 5] },
  { id: 'quotes', main: '"', top: '©', cell: [5, 6] },
  { id: 'f0', main: 'F0', cell: [5, 7] },

  // ── Row 1: A S D F G, F4-F6 ──
  { id: 'a', main: 'A', cell: [1, 0] },
  { id: 's', main: 'S', cell: [1, 1] },
  { id: 'd', main: 'D', cell: [1, 2] },
  { id: 'f', main: 'F', top: '{', cell: [1, 3] },
  { id: 'g', main: 'G', top: '}', cell: [1, 4] },
  { id: 'f4', main: 'F4', cell: [1, 5] },
  { id: 'f5', main: 'F5', cell: [1, 6] },
  { id: 'f6', main: 'F6', cell: [1, 7] },

  // ── Row 6: RETURN, L K J H, SEMICOLON, COLON, EDIT ──
  { id: 'return', main: 'RETURN', cell: [6, 0], dark: true },
  { id: 'l', main: 'L', top: '£', cell: [6, 1] },
  { id: 'k', main: 'K', cell: [6, 2] },
  { id: 'j', main: 'J', cell: [6, 3] },
  { id: 'h', main: 'H', top: '↑', cell: [6, 4] },
  { id: 'semicolon', main: ';', cell: [6, 5] },
  { id: 'colon', main: ':', cell: [6, 6] },
  { id: 'edit', main: 'EDIT', cell: [6, 7], dark: true },

  // ── Row 0: SHIFT, Z X C V, F1-F3 ──
  { id: 'shift', main: 'SHIFT', cell: [0, 0], dark: true },
  { id: 'shift-right', main: 'SHIFT', cell: [0, 0], dark: true },
  { id: 'z', main: 'Z', cell: [0, 1] },
  { id: 'x', main: 'X', top: '?', cell: [0, 2] },
  { id: 'c', main: 'C', cell: [0, 3] },
  { id: 'v', main: 'V', cell: [0, 4] },
  { id: 'f1', main: 'F1', cell: [0, 5] },
  { id: 'f2', main: 'F2', cell: [0, 6] },
  { id: 'f3', main: 'F3', cell: [0, 7] },

  // ── Row 7: SPACE, SYMBOL, M N B, COMMA, PERIOD, INV ──
  { id: 'space', main: '', cell: [7, 0] },
  { id: 'symbol', main: 'SYMBOL', cell: [7, 1], dark: true },
  { id: 'symbol-right', main: 'SYMBOL', cell: [7, 1], dark: true },
  { id: 'm', main: 'M', cell: [7, 2] },
  { id: 'n', main: 'N', cell: [7, 3] },
  { id: 'b', main: 'B', cell: [7, 4] },
  { id: 'comma', main: ',', cell: [7, 5] },
  { id: 'period', main: '.', cell: [7, 6] },
  // The keypad's decimal point. It has no switch of its own — 69 keys is the
  // whole matrix, and every position is already spoken for — so it shares the
  // main full stop, the same way each SHIFT and SYMBOL pair shares one switch.
  { id: 'period-keypad', main: '.', cell: [7, 6] },
  { id: 'inv', main: 'INV', top: '\\', cell: [7, 7] },

  // ── Row 8: CNTRL and the cursor cluster, reachable only when no other
  //    matrix row is selected (see sam-keyboard.ts). ──
  { id: 'cntrl', main: 'CNTRL', cell: [8, 0], dark: true },
  { id: 'up', main: '↑', cell: [8, 1] },
  { id: 'down', main: '↓', cell: [8, 2] },
  { id: 'left', main: '←', cell: [8, 3] },
  { id: 'right', main: '→', cell: [8, 4] },
];

export const SAM_KEY_INDEX: ReadonlyMap<string, SamKey> =
  new Map(SAM_KEYS.map(key => [key.id, key]));
