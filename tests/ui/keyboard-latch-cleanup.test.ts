/**
 * The on-screen keyboards let go of a latched Shift when the pane closes.
 *
 * The latch is a UI affordance, but it asserts a real matrix bit on a machine
 * that outlives the pane. Closing the pane with CAPS/SYMBOL SHIFT (Spectrum) or
 * SHIFT (ZX80/81) latched used to leave that bit held: the machine then read a
 * permanently pressed SHIFT, so every subsequent key typed as its shift level.
 * The Ace controller already released on cleanup; these now agree.
 */

import { describe, expect, it, afterEach, beforeAll } from 'vitest';
import { createRoot } from 'solid-js';
import { setMachine } from '@/shell/context.ts';
import { SpectrumKeyboard } from '@/machines/spectrum/keyboard.ts';
import { Zx8xKeyboard } from '@/machines/zx8x/keyboard.ts';
import { AceKeyboard } from '@/machines/jupiter-ace/keyboard.ts';
import { useKeyboard as useSpectrumKeyboard, CS, SS } from '@/machines/spectrum/ui/keyboard/keyboard-common.tsx';
import { useKeyboard as useZx8xKeyboard } from '@/machines/zx8x/ui/keyboard/keyboard-common.tsx';
import { SHIFT as ZX8X_SHIFT } from '@/machines/zx8x/ui/keyboard/legends.ts';
import { useKeyboard as useAceKeyboard } from '@/machines/jupiter-ace/ui/keyboard/keyboard-common.tsx';
import { SHIFT as ACE_SHIFT, SYMBOL_SHIFT } from '@/machines/jupiter-ace/ui/keyboard/legends.ts';
import type { Machine } from '@/machines/machine.ts';

// The matrix mirror polls with requestAnimationFrame; a Node test has no DOM.
beforeAll(() => {
  (globalThis as any).requestAnimationFrame = () => 0;
  (globalThis as any).cancelAnimationFrame = () => {};
});

/** The shell handle the controllers narrow from, with a real matrix under it. */
function stub(kind: string, keyboard: unknown): Machine {
  return { kind, keyboard } as unknown as Machine;
}

afterEach(() => { setMachine(null); });

/** Run `body` inside a Solid root; `dispose` fires the cleanups a pane close would. */
function withPane<T>(body: () => T): { value: T; dispose: () => void } {
  let value!: T;
  const dispose = createRoot((d) => { value = body(); return d; });
  return { value, dispose };
}

/** True when the matrix bit is held (the rows are active low). */
function held(rows: Uint8Array, [row, bit]: readonly [number, number]): boolean {
  return (rows[row] & (1 << bit)) === 0;
}

describe('Spectrum on-screen keyboard', () => {
  it('releases a latched CAPS SHIFT when the pane closes', () => {
    const kb = new SpectrumKeyboard();
    setMachine(stub('spectrum', kb));
    const pane = withPane(() => useSpectrumKeyboard());
    pane.value.onDown([CS], 'oneshot');
    expect(held(kb.rows, CS), 'latched while the pane is open').toBe(true);
    pane.dispose();
    expect(held(kb.rows, CS), 'released when the pane is gone').toBe(false);
  });

  it('releases a hold latch (EXTEND MODE) too, and both shifts of a chord', () => {
    const kb = new SpectrumKeyboard();
    setMachine(stub('spectrum', kb));
    const pane = withPane(() => useSpectrumKeyboard());
    pane.value.onDown([CS], 'oneshot');
    pane.value.onDown([SS], 'oneshot');   // CAPS+SYMBOL: a pulsed chord
    pane.value.onDown([[6, 4]], 'hold');  // EXTEND MODE, latched
    expect(held(kb.rows, [6, 4])).toBe(true);
    pane.dispose();
    for (const bit of [CS, SS, [6, 4] as const]) {
      expect(held(kb.rows, bit), `row ${bit[0]} bit ${bit[1]}`).toBe(false);
    }
  });

  it('leaves an ordinary key alone — the pane does not own the whole matrix', () => {
    const kb = new SpectrumKeyboard();
    setMachine(stub('spectrum', kb));
    kb.setKey(1, 0, true);                // 'A', held physically
    const pane = withPane(() => useSpectrumKeyboard());
    pane.value.onDown([CS], 'oneshot');
    pane.dispose();
    expect(held(kb.rows, [1, 0]), 'the physical key is still down').toBe(true);
  });
});

describe('ZX81 on-screen keyboard', () => {
  it('releases a latched SHIFT when the pane closes', () => {
    const kb = new Zx8xKeyboard();
    setMachine(stub('zx8x', kb));
    const pane = withPane(() => useZx8xKeyboard());
    pane.value.onDown(ZX8X_SHIFT, true);
    expect(held(kb.rows, ZX8X_SHIFT)).toBe(true);
    pane.dispose();
    expect(held(kb.rows, ZX8X_SHIFT)).toBe(false);
  });

  it('does nothing (and does not throw) with no SHIFT latched', () => {
    const kb = new Zx8xKeyboard();
    setMachine(stub('zx8x', kb));
    const pane = withPane(() => useZx8xKeyboard());
    expect(() => pane.dispose()).not.toThrow();
    expect(held(kb.rows, ZX8X_SHIFT)).toBe(false);
  });
});

describe('Jupiter Ace on-screen keyboard (the model the other two follow)', () => {
  it('releases both latched modifiers when the pane closes', () => {
    const kb = new AceKeyboard();
    setMachine(stub('jupiter-ace', kb));
    const pane = withPane(() => useAceKeyboard());
    pane.value.onDown(ACE_SHIFT, true);
    pane.value.onDown(SYMBOL_SHIFT, true);
    expect(held(kb.rows, ACE_SHIFT)).toBe(true);
    expect(held(kb.rows, SYMBOL_SHIFT)).toBe(true);
    pane.dispose();
    expect(held(kb.rows, ACE_SHIFT)).toBe(false);
    expect(held(kb.rows, SYMBOL_SHIFT)).toBe(false);
  });
});
