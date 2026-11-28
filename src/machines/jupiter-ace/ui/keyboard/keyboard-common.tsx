/**
 * Interaction plumbing for the Jupiter Ace on-screen keyboard.
 *
 * The latch behaviour is the shared one in `@/ui/keyboard/latch-keyboard.ts`.
 * The Ace has two modifiers - SHIFT and SYMBOL SHIFT - and each latches
 * one-shot: held until the next ordinary key is released, or clicked again to
 * unlatch. Unlike the Spectrum there is no SHIFT + SYMBOL SHIFT chord (no
 * extended mode), so a second modifier simply latches alongside the first.
 * (`AceKeyboard.setKey` reference-counts each bit, so a latched modifier and a
 * physical one coexist without desyncing.)
 */

import { useLatchKeyboard } from '@/ui/keyboard/latch-keyboard.ts';
import { activeAce } from '@/machines/jupiter-ace/ui/active.ts';
import type { AceKeyboard } from '@/machines/jupiter-ace/keyboard.ts';
import type { Cell } from './legends.ts';

export interface KeyboardController {
  /** True when this key's matrix bit is currently held (active-low). */
  isDown(pos: Cell): boolean;
  /** Press an ordinary key, or toggle a modifier latch. */
  onDown(pos: Cell, latch?: boolean): void;
  /** Release an ordinary key (and clear any latched modifiers). */
  onUp(pos: Cell, latch?: boolean): void;
}

export function useKeyboard(): KeyboardController {
  const kbd = useLatchKeyboard<AceKeyboard>({
    keyboard: () => activeAce()?.keyboard ?? null,
    rows: (kb) => kb.rows,
    setKey: (kb, row, bit, down) => kb.setKey(row, bit, down),
    rowCount: 8,
    released: 0xff,
  });
  // The deck passes single cells; the shared controller takes a position list.
  return {
    isDown: (pos) => kbd.isDown([pos]),
    onDown: (pos, latch) => kbd.onDown([pos], latch ? 'oneshot' : undefined),
    onUp: (pos, latch) => kbd.onUp([pos], latch ? 'oneshot' : undefined),
  };
}