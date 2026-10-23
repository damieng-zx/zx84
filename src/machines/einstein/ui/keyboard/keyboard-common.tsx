/**
 * Tatung Einstein on-screen keyboard interaction and live highlighting,
 * shared by the TC-01 and 256 faces.
 *
 * Nine rows, not eight: the ninth is the keyboard's synthetic status line,
 * which carries SHIFT / CONTROL / GRAPH (see `einstein-keyboard.ts`).
 *
 * A cap presses a *chord* rather than a single cell, because not every printed
 * key is one switch: the TC-01's twin-arrow cursor caps reach their upper
 * legend through SHIFT, and the 256's cursor-up wedge through CONTROL.
 */

import { createSignal } from 'solid-js';
import { createMatrixKeyboard } from '@/ui/components/matrix-keyboard.ts';
import { activeEinstein } from '@/machines/einstein/ui/active.ts';
import type { EinsteinCell } from './layout.ts';

export interface EinsteinKeyboardController {
  isDown(chord: readonly EinsteinCell[]): boolean;
  onDown(chord: readonly EinsteinCell[]): void;
  onUp(chord: readonly EinsteinCell[]): void;
  /** The 256's ALPHA LOCK latch, for the lamp on its cap. */
  alphaLock(): boolean;
}

export function useEinsteinKeyboard(): EinsteinKeyboardController {
  const [alphaLock, setAlphaLock] = createSignal(false);
  const matrix = createMatrixKeyboard({
    keyboard: () => activeEinstein()?.keyboard ?? null,
    rows: (kb) => kb.rows,
    setCell: (kb, line, bit, down) => kb.setKey(line, bit, down),
    rowCount: 9,
    released: 0xff,
    onFrame: (kb) => { if (kb) setAlphaLock(kb.alphaLockState); },
  });

  return {
    isDown: (chord) => chord.every(([line, bit]) => matrix.isDown(line, bit)),
    onDown: (chord) => { for (const [line, bit] of chord) matrix.press(line, bit); },
    onUp: (chord) => { for (const [line, bit] of chord) matrix.release(line, bit); },
    alphaLock,
  };
}
