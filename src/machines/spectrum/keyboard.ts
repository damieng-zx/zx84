/**
 * ZX Spectrum keyboard emulation.
 *
 * 8 half-rows, 5 bits each, active-low. The matrix and the host-key handling are
 * the ZX machines' common ones (`MatrixKeyKeyboard`); this file is the Spectrum's
 * key map — which key sits at which cell — and its symbol-shift character table.
 *
 * PC keyboard events map to [row, bit] pairs.
 */

import { MatrixKeyKeyboard, type ComboMapping, type KeyMapping } from '@/machines/shared/matrix-key-keyboard.ts';

// [row, bit] for each ZX Spectrum key
// Row 0: SHIFT, Z, X, C, V         (port 0xFEFE)
// Row 1: A, S, D, F, G             (port 0xFDFE)
// Row 2: Q, W, E, R, T             (port 0xFBFE)
// Row 3: 1, 2, 3, 4, 5             (port 0xF7FE)
// Row 4: 0, 9, 8, 7, 6             (port 0xEFFE)
// Row 5: P, O, I, U, Y             (port 0xDFFE)
// Row 6: ENTER, L, K, J, H         (port 0xBFFE)
// Row 7: SPACE, SYM, M, N, B       (port 0x7FFE)

type KeyMap = Record<string, KeyMapping | ComboMapping>;

const KEY_MAP: KeyMap = {
  // Row 0: SHIFT, Z, X, C, V
  'ShiftLeft':    { row: 0, bit: 0 },
  'ShiftRight':   { row: 7, bit: 1 },  // SYM SHIFT (RShift = symbol access)
  'KeyZ':         { row: 0, bit: 1 },
  'KeyX':         { row: 0, bit: 2 },
  'KeyC':         { row: 0, bit: 3 },
  'KeyV':         { row: 0, bit: 4 },

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

  // Row 6: ENTER, L, K, J, H
  'Enter':        { row: 6, bit: 0 },
  'KeyL':         { row: 6, bit: 1 },
  'KeyK':         { row: 6, bit: 2 },
  'KeyJ':         { row: 6, bit: 3 },
  'KeyH':         { row: 6, bit: 4 },

  // Row 7: SPACE, SYM SHIFT, M, N, B
  'Space':        { row: 7, bit: 0 },
  'ControlLeft':  { row: 7, bit: 1 },  // SYM SHIFT
  'ControlRight': { row: 7, bit: 1 },
  'KeyM':         { row: 7, bit: 2 },
  'KeyN':         { row: 7, bit: 3 },
  'KeyB':         { row: 7, bit: 4 },

  // Convenience mappings (key combos)
  'Backspace':    [{ row: 0, bit: 0 }, { row: 4, bit: 0 }],  // SHIFT + 0 (DELETE)
  'Delete':       [{ row: 0, bit: 0 }, { row: 4, bit: 0 }],  // SHIFT + 0 (DELETE)
  'ArrowLeft':    [{ row: 0, bit: 0 }, { row: 3, bit: 4 }],  // SHIFT + 5
  'ArrowDown':    [{ row: 0, bit: 0 }, { row: 4, bit: 4 }],  // SHIFT + 6
  'ArrowUp':      [{ row: 0, bit: 0 }, { row: 4, bit: 3 }],  // SHIFT + 7
  'ArrowRight':   [{ row: 0, bit: 0 }, { row: 4, bit: 2 }],  // SHIFT + 8
  'CapsLock':     [{ row: 0, bit: 0 }, { row: 3, bit: 1 }],  // SHIFT + 2 (CAPS LOCK)
  'Tab':          [{ row: 0, bit: 0 }, { row: 3, bit: 0 }],  // SHIFT + 1 (EDIT)
  'Escape':       [{ row: 0, bit: 0 }, { row: 7, bit: 0 }],  // SHIFT + SPACE (BREAK)
};

// Symbol character → Spectrum key combo (SYM SHIFT + key)
// For PC keys that don't exist on the Spectrum keyboard.
const SS: KeyMapping = { row: 7, bit: 1 };  // Symbol Shift
const CS: KeyMapping = { row: 0, bit: 0 };  // Caps Shift

const CHAR_MAP: Record<string, ComboMapping> = {
  // Punctuation — SYM SHIFT + key
  ',':  [SS, { row: 7, bit: 3 }],  // SYM + N
  '.':  [SS, { row: 7, bit: 2 }],  // SYM + M
  ';':  [SS, { row: 5, bit: 1 }],  // SYM + O
  ':':  [SS, { row: 0, bit: 1 }],  // SYM + Z
  "'":  [SS, { row: 4, bit: 3 }],  // SYM + 7
  '"':  [SS, { row: 5, bit: 0 }],  // SYM + P
  '?':  [SS, { row: 0, bit: 3 }],  // SYM + C
  '/':  [SS, { row: 0, bit: 4 }],  // SYM + V
  '*':  [SS, { row: 7, bit: 4 }],  // SYM + B
  '!':  [SS, { row: 3, bit: 0 }],  // SYM + 1
  '@':  [SS, { row: 3, bit: 1 }],  // SYM + 2
  '#':  [SS, { row: 3, bit: 2 }],  // SYM + 3
  '$':  [SS, { row: 3, bit: 3 }],  // SYM + 4
  '%':  [SS, { row: 3, bit: 4 }],  // SYM + 5
  '&':  [SS, { row: 4, bit: 4 }],  // SYM + 6
  '(':  [SS, { row: 4, bit: 2 }],  // SYM + 8
  ')':  [SS, { row: 4, bit: 1 }],  // SYM + 9
  '-':  [SS, { row: 6, bit: 3 }],  // SYM + J
  '+':  [SS, { row: 6, bit: 2 }],  // SYM + K
  '=':  [SS, { row: 6, bit: 1 }],  // SYM + L
  '_':  [SS, { row: 4, bit: 0 }],  // SYM + 0
  '<':  [SS, { row: 2, bit: 3 }],  // SYM + R
  '>':  [SS, { row: 2, bit: 4 }],  // SYM + T
  '^':  [SS, { row: 6, bit: 4 }],  // SYM + H
  '~':  [SS, { row: 1, bit: 0 }],  // SYM + A
  '|':  [SS, { row: 1, bit: 1 }],  // SYM + S
  '\\': [SS, { row: 1, bit: 2 }],  // SYM + D
  '{':  [SS, { row: 1, bit: 3 }],  // SYM + F
  '}':  [SS, { row: 1, bit: 4 }],  // SYM + G
  // 128K extended mode
  '[':  [CS, SS, { row: 5, bit: 4 }],  // EXT + Y
  ']':  [CS, SS, { row: 5, bit: 3 }],  // EXT + U
};


export class SpectrumKeyboard extends MatrixKeyKeyboard {
  constructor() {
    super({ keyMap: KEY_MAP, charMap: CHAR_MAP, capsShift: CS });
  }
}

