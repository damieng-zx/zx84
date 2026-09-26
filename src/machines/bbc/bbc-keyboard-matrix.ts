/**
 * BBC Micro keyboard matrix — maps a host `KeyboardEvent.code` to the chip's
 * (column, row) cell. Column is driven by the System VIA port A low nibble
 * (0-9, through the 7445 decoder); row is selected by port A bits 4-6 (0-7,
 * through the 74LS251). Values follow JSBeeb's layout.
 */

export const BBC_KEY_MATRIX: Record<string, readonly [number, number]> = {
  // Row 0/1 top row
  Escape: [0, 7],
  F1: [1, 7], F2: [2, 7], F3: [3, 7],
  F4: [4, 1], F5: [4, 7], F6: [5, 7], F7: [6, 1], F8: [6, 7], F9: [7, 7],
  F10: [0, 2], // BBC f0
  Digit1: [0, 3], Digit2: [1, 3], Digit3: [1, 1], Digit4: [2, 1], Digit5: [3, 1],
  Digit6: [4, 3], Digit7: [4, 2], Digit8: [5, 1], Digit9: [6, 2], Digit0: [7, 2],
  Minus: [7, 1], Equal: [7, 1],
  Backslash: [8, 7], Backquote: [8, 1],

  // Letters
  KeyQ: [0, 1], KeyW: [1, 2], KeyE: [2, 2], KeyR: [3, 3], KeyT: [3, 2],
  KeyY: [4, 4], KeyU: [5, 3], KeyI: [5, 2], KeyO: [6, 3], KeyP: [7, 3],
  KeyA: [1, 4], KeyS: [1, 5], KeyD: [2, 3], KeyF: [3, 4], KeyG: [3, 5],
  KeyH: [4, 5], KeyJ: [5, 4], KeyK: [6, 4], KeyL: [6, 5],
  KeyZ: [1, 6], KeyX: [2, 4], KeyC: [2, 5], KeyV: [3, 6], KeyB: [4, 6],
  KeyN: [5, 5], KeyM: [5, 6],

  // Punctuation and editing
  Semicolon: [7, 5], Apostrophe: [8, 4],
  BracketLeft: [8, 3], BracketRight: [8, 5],
  Comma: [6, 6], Period: [7, 6], Slash: [8, 6],
  Space: [2, 6], Tab: [0, 6],
  Enter: [9, 4], Backspace: [9, 5], End: [9, 6], // Copy

  // Cursor keys (BBC uses the same matrix cells as the arrow keys)
  ArrowLeft: [9, 1], ArrowDown: [9, 2], ArrowUp: [9, 3], ArrowRight: [9, 7],

  // Modifiers
  ShiftLeft: [0, 0], ShiftRight: [0, 0],
  ControlLeft: [1, 0], ControlRight: [1, 0],
  CapsLock: [0, 4], ShiftLock: [0, 5],
};

/**
 * Printable character -> the host key (and whether shift is needed) that
 * produces it on the BBC's own layout. The BBC's shifted symbols differ from a
 * PC's (the BBC's `*` is Shift+`:` key, its `_`/`£` has a dedicated key, the
 * number row is `! " # $ % & ' ( )`), so routing by the produced character lets
 * PC users type BBC symbols without relearning the layout. Letters are handled
 * positionally (case comes from the machine's CAPS LOCK state).
 */
export const BBC_CHAR_KEYS: Record<string, { code: string; shift: boolean }> = {
  '0': { code: 'Digit0', shift: false },
  '1': { code: 'Digit1', shift: false }, '!': { code: 'Digit1', shift: true },
  '2': { code: 'Digit2', shift: false }, '"': { code: 'Digit2', shift: true },
  '3': { code: 'Digit3', shift: false }, '4': { code: 'Digit4', shift: false },
  '$': { code: 'Digit4', shift: true },
  '5': { code: 'Digit5', shift: false }, '%': { code: 'Digit5', shift: true },
  '6': { code: 'Digit6', shift: false }, '&': { code: 'Digit6', shift: true },
  '7': { code: 'Digit7', shift: false }, "'": { code: 'Digit7', shift: true },
  '8': { code: 'Digit8', shift: false }, '(': { code: 'Digit8', shift: true },
  '9': { code: 'Digit9', shift: false }, ')': { code: 'Digit9', shift: true },
  '-': { code: 'Minus', shift: false }, '=': { code: 'Minus', shift: true },
  ';': { code: 'Semicolon', shift: false }, '+': { code: 'Semicolon', shift: true },
  ':': { code: 'Apostrophe', shift: false }, '*': { code: 'Apostrophe', shift: true },
  '[': { code: 'BracketLeft', shift: false }, '{': { code: 'BracketLeft', shift: true },
  ']': { code: 'BracketRight', shift: false }, '}': { code: 'BracketRight', shift: true },
  ',': { code: 'Comma', shift: false }, '<': { code: 'Comma', shift: true },
  '.': { code: 'Period', shift: false }, '>': { code: 'Period', shift: true },
  '/': { code: 'Slash', shift: false }, '?': { code: 'Slash', shift: true },
  '\\': { code: 'Backslash', shift: false }, '|': { code: 'Backslash', shift: true },
  '^': { code: 'Backquote', shift: false }, '~': { code: 'Backquote', shift: true },
  ' ': { code: 'Space', shift: false },
};
