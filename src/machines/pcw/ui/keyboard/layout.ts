/**
 * Amstrad PCW key faces, mapped to the keyboard matrix.
 *
 * Cells are `[byte, bit]` into the 16 bytes the gate array writes at &3FF0 —
 * see `pcw-keyboard.ts` for the matrix itself. `main` is the legend printed on
 * the bottom of the cap, `shift` the one above it, and `fn` the small italic
 * word-processing legend the right-hand cluster carries instead of a shifted
 * symbol.
 *
 * Every one of the 82 caps is here, and between them they account for every
 * cell in the matrix except &3FF9 b6-b0, which is the joystick and has no cap.
 *
 * The legends are read off a photographed 8256 deck. Two are worth recording
 * because they are not what CP/M produces: the `> #` cap types `'` under CP/M
 * Plus, and `< §` types `§` — the caps are LocoScript's, and CP/M's own
 * translation table does what it likes with them.
 *
 * The 9512's deck is a different, XT-style arrangement with the function keys
 * down the left. It is not traced here, so a 9512 shows the 8256 deck; the
 * 9256, which kept the 8256 layout, is right either way.
 */

import type { PcwCell } from '@/machines/pcw/pcw-keyboard.ts';

/** `word` caps print a small word (TAB, RETURN, CUT…); `main` caps print a big
 *  letter or symbol; `fn` caps are the right-hand cluster's two-part legends;
 *  `space` is the bar, which prints nothing at all. */
export type PcwKeyRegion = 'main' | 'word' | 'fn' | 'space';

export interface PcwKeyDef {
  readonly id: string;
  readonly cell: PcwCell;
  readonly main: string;
  /** The legend above `main`, for the caps that carry two symbols. */
  readonly shift?: string;
  /** The word-processing legend on a right-cluster cap, printed above its
   *  number: `EXCH\nFIND` over `7`. */
  readonly fn?: string;
  readonly region: PcwKeyRegion;
}

const key = (
  id: string,
  cell: PcwCell,
  main: string,
  shift?: string,
  region: PcwKeyRegion = 'main',
): PcwKeyDef => ({ id, cell, main, shift, region });

/** A right-cluster cap: the word-processing legend over the keypad digit. */
const pad = (id: string, cell: PcwCell, digit: string, fn: string): PcwKeyDef =>
  ({ id, cell, main: digit, fn, region: 'fn' });

/** A cap with a single word on it. */
const word = (id: string, cell: PcwCell, main: string): PcwKeyDef =>
  ({ id, cell, main, region: 'word' });

/** Both SHIFT caps are the same switch, as they are on the real deck. */
const SHIFT: PcwCell = [0x2, 5];

export const PCW_KEYS: readonly PcwKeyDef[] = [
  // ── Row 1: STOP, the number row, the editing caps ────────────────────────
  word('stop', [0x8, 2], 'STOP'),
  key('1', [0x8, 0], '1', '!'),
  key('2', [0x8, 1], '2', '"'),
  key('3', [0x7, 1], '3', '£'),
  key('4', [0x7, 0], '4', '$'),
  key('5', [0x6, 1], '5', '%'),
  key('6', [0x6, 0], '6', '’'),
  key('7', [0x5, 1], '7', '&'),
  key('8', [0x5, 0], '8', '*'),
  key('9', [0x4, 1], '9', '('),
  key('0', [0x4, 0], 'Ø', ')'),
  key('minus', [0x3, 1], '-', '_'),
  key('equals', [0x3, 0], '=', '+'),
  word('del-right', [0x2, 0], 'DEL→'),
  word('del-left', [0x9, 7], '←DEL'),
  word('can', [0xA, 2], 'CAN'),
  word('cut', [0x1, 2], 'CUT'),
  word('copy', [0x1, 3], 'COPY'),
  word('paste', [0x0, 3], 'PASTE'),

  // ── Row 2: TAB, QWERTY, the brackets, RETURN ─────────────────────────────
  word('tab', [0x8, 4], 'TAB'),
  key('q', [0x8, 3], 'Q'),
  key('w', [0x7, 3], 'W'),
  key('e', [0x7, 2], 'E'),
  key('r', [0x6, 2], 'R'),
  key('t', [0x6, 3], 'T'),
  key('y', [0x5, 3], 'Y'),
  key('u', [0x5, 2], 'U'),
  key('i', [0x4, 3], 'I'),
  key('o', [0x4, 2], 'O'),
  key('p', [0x3, 3], 'P'),
  key('bracket-left', [0x3, 2], '[', '{'),
  key('bracket-right', [0x2, 1], ']', '}'),
  word('return', [0x2, 2], 'RETURN'),

  // ── Row 3: SHIFT LOCK, the home row, the punctuation trio ────────────────
  word('shift-lock', [0x8, 6], 'SHIFT\nLOCK'),
  key('a', [0x8, 5], 'A'),
  key('s', [0x7, 4], 'S'),
  key('d', [0x7, 5], 'D'),
  key('f', [0x6, 5], 'F'),
  key('g', [0x6, 4], 'G'),
  key('h', [0x5, 4], 'H'),
  key('j', [0x5, 5], 'J'),
  key('k', [0x4, 5], 'K'),
  key('l', [0x4, 4], 'L'),
  key('semicolon', [0x3, 5], ';', ':'),
  key('section', [0x3, 4], '§', '<'),
  key('hash', [0x2, 3], '#', '>'),

  // ── Row 4: the SHIFTs and the bottom letter row ──────────────────────────
  word('shift-left', SHIFT, 'SHIFT'),
  key('z', [0x8, 7], 'Z'),
  key('x', [0x7, 7], 'X'),
  key('c', [0x7, 6], 'C'),
  key('v', [0x6, 7], 'V'),
  key('b', [0x6, 6], 'B'),
  key('n', [0x5, 6], 'N'),
  key('m', [0x4, 6], 'M'),
  key('comma', [0x4, 7], ',', ';'),
  key('period', [0x3, 7], '.', ':'),
  key('slash', [0x3, 6], '/', '?'),
  key('half', [0x2, 6], '½', '@'),
  word('shift-right', SHIFT, 'SHIFT'),

  // ── Row 5: ALT, EXTRA, the two boxed caps around the bar, PTR and EXIT ───
  word('alt', [0xA, 7], 'ALT'),
  word('extra', [0xA, 1], 'EXTRA'),
  key('box-plus', [0x2, 7], '⊞'),
  key('space', [0x5, 7], '', undefined, 'space'),
  key('box-minus', [0xA, 3], '⊟'),
  word('ptr', [0x1, 1], 'PTR'),
  word('exit', [0x1, 0], 'EXIT'),

  // ── The right-hand cluster: function keys and the numeric pad ────────────
  //
  // Each function cap carries two legends because SHIFT picks the higher of the
  // pair: f7 unshifted, f8 shifted, and so on down. The pad caps print their
  // word-processing job above the digit.
  key('f8-f7', [0xA, 4], 'f7', 'f8', 'fn'),
  pad('pad7', [0x2, 4], '7', 'EXCH\nFIND'),
  pad('pad8', [0x1, 4], '8', 'DOC\nPAGE'),
  pad('pad9', [0x0, 4], '9', 'UNIT\nPARA'),

  key('f6-f5', [0xA, 0], 'f5', 'f6', 'fn'),
  pad('pad4', [0x1, 5], '4', 'LINE\nEOL'),
  pad('pad5', [0x1, 6], '5', '↑'),
  pad('pad6', [0x0, 5], '6', 'WORD\nCHAR'),

  key('f4-f3', [0x0, 0], 'f3', 'f4', 'fn'),
  pad('pad1', [0x1, 7], '1', '←'),
  pad('pad2', [0x0, 7], '2', '▒'),
  pad('pad3', [0x0, 6], '3', '→'),

  key('f2-f1', [0x0, 2], 'f1', 'f2', 'fn'),
  pad('pad0', [0x0, 1], 'Ø', 'RELAY'),
  pad('pad-dot', [0xA, 6], '.', '↓'),
  word('pad-enter', [0xA, 5], 'ENTER'),
] as const;

export const PCW_KEY_INDEX = new Map(
  PCW_KEYS.map((definition) => [definition.id, definition] as const),
);
