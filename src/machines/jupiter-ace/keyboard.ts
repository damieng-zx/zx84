/**
 * AceKeyboard — Jupiter Ace keyboard matrix.
 *
 * The scan hardware and the host-key handling are the ZX machines' common ones
 * (`MatrixKeyKeyboard`); this file is the Ace's key map and symbol-shift
 * character table. Identical scanning to the ZX Spectrum (both ULAs came from
 * the same designer): eight half-rows of five bits, selected by the high byte of
 * a port 0xFE read (a 0 bit selects the row), keys active-low. The Ace's matrix
 * is, as the ROM's own key tables confirm (see
 * tests/jupiter-ace/ace-keyboard-rom.test.ts):
 *
 *   row 0 (0xFE): SHIFT   SYM     Z   X   C
 *   row 1 (0xFD): A       S       D   F   G
 *   row 2 (0xFB): Q       W       E   R   T
 *   row 3 (0xF7): 1       2       3   4   5
 *   row 4 (0xEF): 0       9       8   7   6
 *   row 5 (0xDF): P       O       I   U   Y
 *   row 6 (0xBF): NEWLINE L       K   J   H
 *   row 7 (0x7F): SPACE   M       N   B   V
 *
 * Unlike the Spectrum, the Ace has a dedicated SYMBOL SHIFT key (row 0, bit 1);
 * every key's symbol character comes from SYMBOL SHIFT + key in ROM software.
 * The host map follows the Spectrum keyboard's conventions: Right-Ctrl (and
 * Right-Shift) map to SYMBOL SHIFT, and PC-only characters are delivered as
 * symbol-shift combos via CHAR_MAP.
 */

import { MatrixKeyKeyboard, type ComboMapping, type KeyMapping } from '@/machines/shared/matrix-key-keyboard.ts';

// [row, bit] for each Ace key.
const KEY_MAP: Record<string, KeyMapping | ComboMapping> = {
  // Row 0: SHIFT, SYM SHIFT, Z, X, C
  'ShiftLeft':    { row: 0, bit: 0 },
  'ShiftRight':   { row: 0, bit: 1 },  // SYMBOL SHIFT (RShift = symbol access)
  'ControlLeft':  { row: 0, bit: 1 },  // SYMBOL SHIFT
  'ControlRight': { row: 0, bit: 1 },
  'KeyZ':         { row: 0, bit: 2 },
  'KeyX':         { row: 0, bit: 3 },
  'KeyC':         { row: 0, bit: 4 },

  // Row 1: A, S, D, F, G
  'KeyA':         { row: 1, bit: 0 },
  'KeyS':         { row: 1, bit: 1 },
  'KeyD':         { row: 1, bit: 2 },
  'KeyF':         { row: 1, bit: 3 },
  'KeyG':         { row: 1, bit: 4 },

  // Row 2: Q, W, E, R, T
  'KeyQ':         { row: 2, bit: 0 },
  'KeyW':         { row: 2, bit: 1 },
  'KeyE':         { row: 2, bit: 2 },
  'KeyR':         { row: 2, bit: 3 },
  'KeyT':         { row: 2, bit: 4 },

  // Row 3: 1, 2, 3, 4, 5
  'Digit1':       { row: 3, bit: 0 },
  'Digit2':       { row: 3, bit: 1 },
  'Digit3':       { row: 3, bit: 2 },
  'Digit4':       { row: 3, bit: 3 },
  'Digit5':       { row: 3, bit: 4 },

  // Row 4: 0, 9, 8, 7, 6
  'Digit0':       { row: 4, bit: 0 },
  'Digit9':       { row: 4, bit: 1 },
  'Digit8':       { row: 4, bit: 2 },
  'Digit7':       { row: 4, bit: 3 },
  'Digit6':       { row: 4, bit: 4 },

  // Row 5: P, O, I, U, Y
  'KeyP':         { row: 5, bit: 0 },
  'KeyO':         { row: 5, bit: 1 },
  'KeyI':         { row: 5, bit: 2 },
  'KeyU':         { row: 5, bit: 3 },
  'KeyY':         { row: 5, bit: 4 },

  // Row 6: NEWLINE, L, K, J, H
  'Enter':        { row: 6, bit: 0 },
  'KeyL':         { row: 6, bit: 1 },
  'KeyK':         { row: 6, bit: 2 },
  'KeyJ':         { row: 6, bit: 3 },
  'KeyH':         { row: 6, bit: 4 },

  // Row 7: SPACE, M, N, B, V
  'Space':        { row: 7, bit: 0 },
  'KeyM':         { row: 7, bit: 1 },
  'KeyN':         { row: 7, bit: 2 },
  'KeyB':         { row: 7, bit: 3 },
  'KeyV':         { row: 7, bit: 4 },

  // Convenience mappings (key combos)
  'Backspace':    [{ row: 0, bit: 0 }, { row: 4, bit: 0 }],  // SHIFT + 0 (DELETE)
  'Delete':       [{ row: 0, bit: 0 }, { row: 4, bit: 0 }],  // SHIFT + 0 (DELETE)
  'ArrowLeft':    [{ row: 0, bit: 0 }, { row: 3, bit: 4 }],  // SHIFT + 5
  // Unlike the Spectrum, the Ace's SHIFT+6 is cursor UP and SHIFT+7 DOWN.
  'ArrowUp':      [{ row: 0, bit: 0 }, { row: 4, bit: 4 }],  // SHIFT + 6
  'ArrowDown':    [{ row: 0, bit: 0 }, { row: 4, bit: 3 }],  // SHIFT + 7
  'ArrowRight':   [{ row: 0, bit: 0 }, { row: 4, bit: 2 }],  // SHIFT + 8
  'CapsLock':     [{ row: 0, bit: 0 }, { row: 3, bit: 1 }],  // SHIFT + 2 (CAPS LOCK)
  'Escape':       [{ row: 0, bit: 0 }, { row: 7, bit: 0 }],  // SHIFT + SPACE (BREAK)
};

// Symbol character → Ace key combo. Every printable symbol is SYMBOL SHIFT +
// key — the ROM's SYMBOL SHIFT decode table at 0x03C6. SHIFT + digit is not a
// symbol on the Ace: its SHIFT table (0x039E) gives the editing controls
// (DELETE LINE, CAPS LOCK, INVERSE VIDEO, cursor keys, GRAPHICS, DELETE).
const SS: KeyMapping = { row: 0, bit: 1 };  // Symbol Shift

const CHAR_MAP: Record<string, ComboMapping> = {
  '!':  [SS, { row: 3, bit: 0 }],  // SYM + 1
  '@':  [SS, { row: 3, bit: 1 }],  // SYM + 2
  '#':  [SS, { row: 3, bit: 2 }],  // SYM + 3
  '$':  [SS, { row: 3, bit: 3 }],  // SYM + 4
  '%':  [SS, { row: 3, bit: 4 }],  // SYM + 5
  '&':  [SS, { row: 4, bit: 4 }],  // SYM + 6
  "'":  [SS, { row: 4, bit: 3 }],  // SYM + 7
  '(':  [SS, { row: 4, bit: 2 }],  // SYM + 8
  ')':  [SS, { row: 4, bit: 1 }],  // SYM + 9
  '_':  [SS, { row: 4, bit: 0 }],  // SYM + 0
  '"':  [SS, { row: 5, bit: 0 }],  // SYM + P
  ':':  [SS, { row: 0, bit: 2 }],  // SYM + Z
  '?':  [SS, { row: 0, bit: 4 }],  // SYM + C
  '~':  [SS, { row: 1, bit: 0 }],  // SYM + A
  '|':  [SS, { row: 1, bit: 1 }],  // SYM + S
  '\\': [SS, { row: 1, bit: 2 }],  // SYM + D
  '{':  [SS, { row: 1, bit: 3 }],  // SYM + F
  '}':  [SS, { row: 1, bit: 4 }],  // SYM + G
  '<':  [SS, { row: 2, bit: 3 }],  // SYM + R
  '>':  [SS, { row: 2, bit: 4 }],  // SYM + T
  ';':  [SS, { row: 5, bit: 1 }],  // SYM + O
  '[':  [SS, { row: 5, bit: 4 }],  // SYM + Y
  ']':  [SS, { row: 5, bit: 3 }],  // SYM + U
  '=':  [SS, { row: 6, bit: 1 }],  // SYM + L
  '+':  [SS, { row: 6, bit: 2 }],  // SYM + K
  '-':  [SS, { row: 6, bit: 3 }],  // SYM + J
  '^':  [SS, { row: 6, bit: 4 }],  // SYM + H
  '.':  [SS, { row: 7, bit: 1 }],  // SYM + M
  ',':  [SS, { row: 7, bit: 2 }],  // SYM + N
  '*':  [SS, { row: 7, bit: 3 }],  // SYM + B
  '/':  [SS, { row: 7, bit: 4 }],  // SYM + V
};


export class AceKeyboard extends MatrixKeyKeyboard {
  constructor() {
    // The Ace has a real SYMBOL SHIFT at [0,1]; its "CAPS SHIFT" is [0,0].
    super({ keyMap: KEY_MAP, charMap: CHAR_MAP, capsShift: { row: 0, bit: 0 } });
  }
}

