/**
 * Acorn Electron keyboard matrix.
 *
 * The 56-key keyboard is a 14 × 4 matrix read through the ULA: with ROM page 8
 * or 9 selected, a read in 0x8000-0xBFFF returns, in D0-D3, the pressed keys of
 * every column whose address line (A0-A13) is low. So a key is (column, row)
 * where column is the address bit and row the data bit.
 *
 * Keys are named by their Electron keycap. Cursor keys carry symbols too: on
 * the real machine SHIFT gives `^ _ £ |` (and `[` on COPY) and CTRL gives
 * `~ } { \` (and `]`).
 */

export type ElectronCell = readonly [column: number, row: number];

export const ELK_KEYS = {
  right: [0, 0], copy: [0, 1], space: [0, 3],
  left: [1, 0], down: [1, 1], return: [1, 2], delete: [1, 3],
  minus: [2, 0], up: [2, 1], colon: [2, 2],
  '0': [3, 0], p: [3, 1], semicolon: [3, 2], slash: [3, 3],
  '9': [4, 0], o: [4, 1], l: [4, 2], period: [4, 3],
  '8': [5, 0], i: [5, 1], k: [5, 2], comma: [5, 3],
  '7': [6, 0], u: [6, 1], j: [6, 2], m: [6, 3],
  '6': [7, 0], y: [7, 1], h: [7, 2], n: [7, 3],
  '5': [8, 0], t: [8, 1], g: [8, 2], b: [8, 3],
  '4': [9, 0], r: [9, 1], f: [9, 2], v: [9, 3],
  '3': [10, 0], e: [10, 1], d: [10, 2], c: [10, 3],
  '2': [11, 0], w: [11, 1], s: [11, 2], x: [11, 3],
  '1': [12, 0], q: [12, 1], a: [12, 2], z: [12, 3],
  escape: [13, 0], func: [13, 1], ctrl: [13, 2], shift: [13, 3],
} as const satisfies Record<string, ElectronCell>;

export type ElectronKeyName = keyof typeof ELK_KEYS;

/** Physical host key → Electron key, for keys that are not typed by character. */
export const ELK_CODE_KEYS: Record<string, ElectronKeyName> = {
  Escape: 'escape',
  Enter: 'return', NumpadEnter: 'return',
  Backspace: 'delete', Delete: 'delete',
  End: 'copy', Home: 'copy', Insert: 'copy',
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  Space: 'space',
  ControlLeft: 'ctrl', ControlRight: 'ctrl',
  CapsLock: 'ctrl',                    // the Electron's CAPS LOCK is the CTRL key tapped alone
  KeyA: 'a', KeyB: 'b', KeyC: 'c', KeyD: 'd', KeyE: 'e', KeyF: 'f', KeyG: 'g',
  KeyH: 'h', KeyI: 'i', KeyJ: 'j', KeyK: 'k', KeyL: 'l', KeyM: 'm', KeyN: 'n',
  KeyO: 'o', KeyP: 'p', KeyQ: 'q', KeyR: 'r', KeyS: 's', KeyT: 't', KeyU: 'u',
  KeyV: 'v', KeyW: 'w', KeyX: 'x', KeyY: 'y', KeyZ: 'z',
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  Minus: 'minus', Semicolon: 'semicolon', Comma: 'comma', Period: 'period', Slash: 'slash',
  Tab: 'func',
};

/** FUNC + a digit key gives f0-f9 (F10 is f0). */
export const ELK_FUNCTION_KEYS: Record<string, ElectronKeyName> = {
  F1: '1', F2: '2', F3: '3', F4: '4', F5: '5', F6: '6', F7: '7', F8: '8', F9: '9', F10: '0',
};

/** What a typed character needs pressed on the Electron's keycaps. */
export interface ElectronChord {
  readonly key: ElectronKeyName;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
}

/**
 * Printable character → chord. Routing by the produced character lets a PC
 * keyboard type the Electron's own shifted symbols (its `"` is Shift+2, `@` is
 * Shift+0, `*` is Shift+`:`, and `^ _ £ | [` / `~ } { \ ]` live on the
 * cursor/COPY keys). Letters are handled separately so caps lock is honoured.
 */
export const ELK_CHAR_CHORDS: Record<string, ElectronChord> = {
  '1': { key: '1' }, '!': { key: '1', shift: true },
  '2': { key: '2' }, '"': { key: '2', shift: true },
  '3': { key: '3' }, '#': { key: '3', shift: true },
  '4': { key: '4' }, '$': { key: '4', shift: true },
  '5': { key: '5' }, '%': { key: '5', shift: true },
  '6': { key: '6' }, '&': { key: '6', shift: true },
  '7': { key: '7' }, "'": { key: '7', shift: true },
  '8': { key: '8' }, '(': { key: '8', shift: true },
  '9': { key: '9' }, ')': { key: '9', shift: true },
  '0': { key: '0' }, '@': { key: '0', shift: true },
  '-': { key: 'minus' }, '=': { key: 'minus', shift: true },
  ':': { key: 'colon' }, '*': { key: 'colon', shift: true },
  ';': { key: 'semicolon' }, '+': { key: 'semicolon', shift: true },
  '/': { key: 'slash' }, '?': { key: 'slash', shift: true },
  ',': { key: 'comma' }, '<': { key: 'comma', shift: true },
  '.': { key: 'period' }, '>': { key: 'period', shift: true },
  '^': { key: 'left', shift: true }, '~': { key: 'left', ctrl: true },
  '_': { key: 'down', shift: true }, '}': { key: 'down', ctrl: true },
  '£': { key: 'up', shift: true }, '{': { key: 'up', ctrl: true },
  '|': { key: 'right', shift: true }, '\\': { key: 'right', ctrl: true },
  '[': { key: 'copy', shift: true }, ']': { key: 'copy', ctrl: true },
  ' ': { key: 'space' },
};
