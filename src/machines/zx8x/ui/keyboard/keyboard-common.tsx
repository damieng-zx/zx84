/**
 * Interaction plumbing for the ZX81 / ZX80 on-screen keyboard.
 *
 * The latch behaviour is the shared one in `@/ui/keyboard/latch-keyboard.ts`.
 * The ZX8x has a single modifier - SHIFT - which latches one-shot: held until
 * the next ordinary key is released, or clicked again to unlatch. (The matrix
 * bits are reference-counted in `Zx8xKeyboard.setKey`, so a latched SHIFT and a
 * physical Shift coexist without desyncing.)
 */

import { useLatchKeyboard } from '@/ui/keyboard/latch-keyboard.ts';
import { activeZx8x } from '@/machines/zx8x/ui/active.ts';
import type { Zx8xKeyboard } from '@/machines/zx8x/keyboard.ts';
import type { Cell } from './legends.ts';

export interface KeyboardController {
  /** True when this key's matrix bit is currently held (active-low). */
  isDown(pos: Cell): boolean;
  /** Press an ordinary key, or toggle the SHIFT latch. */
  onDown(pos: Cell, latch?: boolean): void;
  /** Release an ordinary key (and clear a one-shot SHIFT latch). */
  onUp(pos: Cell, latch?: boolean): void;
}

export function useKeyboard(): KeyboardController {
  const kbd = useLatchKeyboard<Zx8xKeyboard>({
    keyboard: () => activeZx8x()?.keyboard ?? null,
    rows: (kb) => kb.rows,
    setKey: (kb, row, bit, down) => kb.setKey(row, bit, down),
    rowCount: 8,
    released: 0xff,
  });
  // The deck passes single cells and a boolean SHIFT toggle; the shared
  // controller takes a position list and a latch mode.
  return {
    isDown: (pos) => kbd.isDown([pos]),
    onDown: (pos, latch) => kbd.onDown([pos], latch ? 'oneshot' : undefined),
    onUp: (pos, latch) => kbd.onUp([pos], latch ? 'oneshot' : undefined),
  };
}