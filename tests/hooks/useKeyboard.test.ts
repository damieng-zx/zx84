/**
 * useKeyboard — on-screen keyboard interaction controller.
 *
 * Drives the live Spectrum keyboard matrix from pointer presses on the virtual
 * keyboard. The behaviours pinned here are the sticky-latch state machine:
 *
 *   • a one-shot latch (CAPS / SYMBOL SHIFT) asserts its matrix bit until an
 *     ordinary key is pressed, or it is clicked again to unlatch;
 *   • CAPS+SYMBOL together = EXTEND MODE. Real hardware enters that mode on a
 *     momentary chord; holding both shifts down indefinitely makes the ROM
 *     auto-repeat the toggle (it flickers in and out). So a second one-shot
 *     latch pressed while another is already latched must deliver a *brief*
 *     chord — both bits down together, then released — not a permanent latch.
 *
 * The hook reads the `spectrum` global and lives on a Solid reactive owner, so
 * each test mocks `@/emulator.ts` and runs inside `createRoot`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'solid-js';

// A minimal, reference-counted stand-in for SpectrumKeyboard: enough for the
// hook, which only calls setKey() and (in its rAF poll) reads rows.
vi.mock('@/emulator.ts', () => {
  const rows = new Uint8Array(8).fill(0xff);
  const counts = Array.from({ length: 8 }, () => new Array(5).fill(0));
  const keyboard = {
    rows,
    setKey(r: number, b: number, on: boolean) {
      counts[r][b] = on ? counts[r][b] + 1 : Math.max(0, counts[r][b] - 1);
      if (counts[r][b] > 0) rows[r] &= ~(1 << b);
      else rows[r] |= 1 << b;
    },
    _reset() {
      rows.fill(0xff);
      for (const row of counts) row.fill(0);
    },
  };
  return { spectrum: { keyboard } };
});

import { useKeyboard, CS, SS } from '@/machines/spectrum/ui/keyboard/keyboard-common.tsx';
import { spectrum } from '@/emulator.ts';

const kb = () => spectrum!.keyboard;
const down = (r: number, b: number) => (kb().rows[r] & (1 << b)) === 0;

// The hook's onMount poll uses requestAnimationFrame; stub it to a no-op so the
// loop never schedules in the node test environment.
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as any).requestAnimationFrame = () => 0;
  (globalThis as any).cancelAnimationFrame = () => {};
  (kb() as any)._reset();
});

afterEach(() => {
  vi.useRealTimers();
});

function withRoot<T>(fn: (dispose: () => void) => T): T {
  let result!: T;
  createRoot((dispose) => { result = fn(dispose); });
  return result;
}

describe('useKeyboard — one-shot latch', () => {
  it('latches a single shift on press and holds it (no pointer-up release)', () => {
    withRoot(() => {
      const c = useKeyboard();
      c.onDown([CS], 'oneshot');
      expect(down(...CS)).toBe(true);
      c.onUp([CS], 'oneshot'); // latched keys ignore pointer-up
      expect(down(...CS)).toBe(true);
    });
  });

  it('clicking the same latch again unlatches it', () => {
    withRoot(() => {
      const c = useKeyboard();
      c.onDown([CS], 'oneshot');
      c.onDown([CS], 'oneshot');
      expect(down(...CS)).toBe(false);
    });
  });

  it('an ordinary key press-and-release drops the one-shot latch', () => {
    withRoot(() => {
      const c = useKeyboard();
      c.onDown([CS], 'oneshot');
      const A: [number, number] = [1, 0];
      c.onDown([A]);            // ordinary key
      c.onUp([A]);
      expect(down(...A)).toBe(false);
      expect(down(...CS)).toBe(false); // latch consumed
    });
  });
});

describe('useKeyboard — CAPS+SYMBOL chord (EXTEND MODE)', () => {
  it('asserts both shifts together when the second is pressed', () => {
    withRoot(() => {
      const c = useKeyboard();
      c.onDown([CS], 'oneshot');
      c.onDown([SS], 'oneshot');
      // Both down simultaneously so the ROM sees the chord and enters E-mode.
      expect(down(...CS)).toBe(true);
      expect(down(...SS)).toBe(true);
    });
  });

  it('releases both shifts shortly after — does NOT hold them latched', () => {
    withRoot(() => {
      const c = useKeyboard();
      c.onDown([CS], 'oneshot');
      c.onDown([SS], 'oneshot');
      vi.advanceTimersByTime(1000); // well past the brief chord pulse
      // Neither shift remains asserted — holding both is what flickers E-mode.
      expect(down(...CS)).toBe(false);
      expect(down(...SS)).toBe(false);
    });
  });

  it('the chord pulse outlasts several 50Hz keyboard scans (>=40ms)', () => {
    withRoot(() => {
      const c = useKeyboard();
      c.onDown([CS], 'oneshot');
      c.onDown([SS], 'oneshot');
      vi.advanceTimersByTime(40); // two frames — ROM must still see the chord
      expect(down(...CS)).toBe(true);
      expect(down(...SS)).toBe(true);
    });
  });

  it('chord works regardless of which shift is pressed first', () => {
    withRoot(() => {
      const c = useKeyboard();
      c.onDown([SS], 'oneshot');
      c.onDown([CS], 'oneshot');
      expect(down(...CS)).toBe(true);
      expect(down(...SS)).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(down(...CS)).toBe(false);
      expect(down(...SS)).toBe(false);
    });
  });

  it('after the chord, no shift is left latched so the next letter is unshifted', () => {
    withRoot(() => {
      const c = useKeyboard();
      c.onDown([CS], 'oneshot');
      c.onDown([SS], 'oneshot');
      vi.advanceTimersByTime(1000);
      const Q: [number, number] = [2, 0];
      c.onDown([Q]);
      expect(down(...Q)).toBe(true);
      expect(down(...CS)).toBe(false);
      expect(down(...SS)).toBe(false);
    });
  });
});
