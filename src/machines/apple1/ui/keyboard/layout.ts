/**
 * Apple I key faces and their placement.
 *
 * The Apple I took any ASCII keyboard; the one photographed with the board has
 * the teletype arrangement the Apple ][ inherited — ESC beside Q, SHIFT only
 * changing the symbol caps and three letters — plus RESET and CLEAR SCREEN keys
 * that never reach the PIA. There is no matrix to scan: a cap's `face` is the DOM
 * key code fed to the encoder (or an id for a cap the PC lacks, like `: *`), so a
 * physical keystroke can light the matching cap.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';

export type Apple1KeyAction = 'char' | 'shift' | 'ctrl' | 'reset' | 'clear';
export type Apple1KeyRegion = 'main' | 'word' | 'space' | 'cursor';

export interface Apple1KeyDef {
  /** Unique cap id. */
  readonly id: string;
  /** DOM key code (or encoder face id) this cap presses. */
  readonly face: string;
  readonly main: string;
  readonly shift?: string;
  readonly action: Apple1KeyAction;
  readonly region: Apple1KeyRegion;
  /** Other host key codes that light this cap. */
  readonly host?: readonly string[];
}

export interface PlacedApple1Key {
  readonly key: Apple1KeyDef;
  readonly box: SceneBox;
}

function char(face: string, main: string, shift?: string): Apple1KeyDef {
  return { id: face, face, main, shift, action: 'char', region: 'main' };
}

function word(
  id: string, face: string, main: string, action: Apple1KeyAction = 'char', host?: readonly string[],
): Apple1KeyDef {
  return { id, face, main, action, region: 'word', host };
}

const letters = (row: string): Apple1KeyDef[] => [...row].map((ch) => char(`Key${ch}`, ch));

export const APPLE1_KEYS: readonly Apple1KeyDef[] = [
  char('Digit1', '1', '!'),
  char('Digit2', '2', '"'),
  char('Digit3', '3', '#'),
  char('Digit4', '4', '$'),
  char('Digit5', '5', '%'),
  char('Digit6', '6', '&'),
  char('Digit7', '7', "'"),
  char('Digit8', '8', '('),
  char('Digit9', '9', ')'),
  char('Digit0', '0'),
  char('colon', ':', '*'),
  char('Minus', '-', '='),
  word('clear', 'clear', 'CLEAR\nSCREEN', 'clear', ['Home']),
  word('reset', 'reset', 'RESET', 'reset', ['Pause']),

  word('Escape', 'Escape', 'ESC'),
  ...letters('QWERTYUIO'),
  char('KeyP', 'P', '@'),
  word('Enter', 'Enter', 'RETURN', 'char', ['NumpadEnter']),

  word('ctrl', 'ControlLeft', 'CTRL', 'ctrl', ['ControlRight']),
  ...letters('ASDFGHJKL'),
  char('Semicolon', ';', '+'),
  { id: 'Backspace', face: 'Backspace', main: '←', action: 'char', region: 'cursor', host: ['Delete'] },

  word('shift-left', 'ShiftLeft', 'SHIFT', 'shift'),
  ...letters('ZXCVB'),
  char('KeyN', 'N', '^'),
  char('KeyM', 'M', ']'),
  char('Comma', ',', '<'),
  char('Period', '.', '>'),
  char('Slash', '/', '?'),
  word('shift-right', 'ShiftRight', 'SHIFT', 'shift'),

  { id: 'Space', face: 'Space', main: '', action: 'char', region: 'space' },
];

const PITCH = 40;
const CAP = 36;

export const APPLE1_SCENE = { width: 600, height: 240, unit: 1 } as const;

/** Every cap placed exactly once on the 40-unit pitch. */
export function placeApple1Keys(): readonly PlacedApple1Key[] {
  const index = new Map(APPLE1_KEYS.map((key) => [key.id, key] as const));
  const placed: PlacedApple1Key[] = [];
  const put = (id: string, x: number, y: number, width = CAP, height = CAP): void => {
    const key = index.get(id);
    if (!key) throw new Error(`Unknown Apple I key: ${id}`);
    placed.push({ key, box: { x, y, width, height } });
  };
  const run = (ids: readonly string[], x: number, y: number): void =>
    ids.forEach((id, i) => put(id, x + i * PITCH, y));
  const keyIds = (row: string): string[] => [...row].map((ch) => `Key${ch}`);
  const digits = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
  const [r1, r2, r3, r4, r5] = [18, 60, 102, 144, 186];

  run([...digits, 'colon', 'Minus', 'clear', 'reset'], 20, r1);
  put('Escape', 20, r2);
  run(keyIds('QWERTYUIOP'), 60, r2);
  put('Enter', 500, r2, 56);
  put('ctrl', 10, r3, 56);
  run([...keyIds('ASDFGHJKL'), 'Semicolon'], 70, r3);
  put('Backspace', 470, r3, 56);
  put('shift-left', 10, r4, 76);
  run([...keyIds('ZXCVBNM'), 'Comma', 'Period', 'Slash'], 90, r4);
  put('shift-right', 490, r4, 66);
  put('Space', 130, r5, 316);

  if (placed.length !== index.size) {
    const seen = new Set(placed.map((p) => p.key.id));
    throw new Error(`Apple I keys not placed: ${[...index.keys()].filter((id) => !seen.has(id)).join(', ')}`);
  }
  return placed;
}
