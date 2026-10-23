/**
 * PCW on-screen keyboard interaction and live highlighting.
 *
 * The PCW's keyboard is not a port to be read: the gate array DMAs sixteen
 * bytes into memory and software reads them there, so "press a key" here means
 * "set that bit in the matrix" and nothing else. `PcwKeyboard.setCell` keeps
 * the pointer's presses in their own set, so a cap pressed here and the same
 * cap pressed on the host keyboard cannot release each other.
 *
 * Both SHIFT caps are one switch, so pressing either lights both — which is
 * what the hardware does. SHIFT LOCK latches rather than staying down, so it
 * is shown lit from the keyboard's own lock state rather than from the matrix.
 */

import { createSignal } from 'solid-js';
import { createMatrixKeyboard } from '@/ui/components/matrix-keyboard.ts';
import { activePcw } from '@/machines/pcw/ui/active.ts';
import type { PcwCell } from '@/machines/pcw/pcw-keyboard.ts';

/** The eleven key bytes; the rest are links and flags. */
const KEY_BYTES = 0x0B;

export interface PcwKeyboardController {
  isDown(id: string, cell: PcwCell): boolean;
  onDown(cell: PcwCell): void;
  onUp(cell: PcwCell): void;
}

/** SHIFT LOCK's cell — shown from the lock state, not from the bit. */
const SHIFT_LOCK_ID = 'shift-lock';

export function usePcwKeyboard(): PcwKeyboardController {
  const [locked, setLocked] = createSignal(false);
  const matrix = createMatrixKeyboard({
    keyboard: () => activePcw()?.keyboard ?? null,
    rows: (kb) => kb.matrix,
    setCell: (kb, byte, bit, down) => kb.setCell([byte, bit], down),
    rowCount: KEY_BYTES,
    released: 0,
    activeLow: false,
    onFrame: (kb) => { if (kb && kb.shiftLock !== locked()) setLocked(kb.shiftLock); },
  });

  return {
    isDown: (id, cell) => (id === SHIFT_LOCK_ID ? locked() : matrix.isDown(cell[0], cell[1])),
    onDown: ([byte, bit]) => matrix.press(byte, bit),
    onUp: ([byte, bit]) => matrix.release(byte, bit),
  };
}
