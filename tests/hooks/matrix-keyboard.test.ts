/**
 * createMatrixKeyboard — the shared on-screen-keyboard matrix mirror.
 *
 * Pins what every matrix machine's keyboard relies on: pressed cells reach the
 * keyboard once, release only what is held, polarity decides what "down" means,
 * and held cells are let go when the owning pane is disposed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot } from 'solid-js';
import { createMatrixKeyboard } from '@/ui/components/matrix-keyboard.ts';

class FakeKeyboard {
  rows = new Uint8Array(4).fill(0xff);
  calls: string[] = [];
  setKey(line: number, bit: number, down: boolean): void {
    this.calls.push(`${line},${bit},${down ? 'down' : 'up'}`);
    if (down) this.rows[line] &= ~(1 << bit);
    else this.rows[line] |= 1 << bit;
  }
}

let frames: Array<() => void>;

beforeEach(() => {
  frames = [];
  (globalThis as any).requestAnimationFrame = (cb: () => void) => { frames.push(cb); return frames.length; };
  (globalThis as any).cancelAnimationFrame = () => {};
});

function setup(kb: FakeKeyboard | null, extra: Partial<Parameters<typeof createMatrixKeyboard<FakeKeyboard>>[0]> = {}) {
  let dispose = () => {};
  const matrix = createRoot((d) => {
    dispose = d;
    return createMatrixKeyboard<FakeKeyboard>({
      keyboard: () => kb,
      rows: (k) => k.rows,
      setCell: (k, line, bit, down) => k.setKey(line, bit, down),
      rowCount: 4,
      released: 0xff,
      ...extra,
    });
  });
  return { matrix, dispose };
}

describe('createMatrixKeyboard', () => {
  it('presses a held cell only once', () => {
    const kb = new FakeKeyboard();
    const { matrix } = setup(kb);
    matrix.press(1, 3);
    matrix.press(1, 3);
    expect(kb.calls).toEqual(['1,3,down']);
  });

  it('releases only cells that are held', () => {
    const kb = new FakeKeyboard();
    const { matrix } = setup(kb);
    matrix.release(2, 2);
    expect(kb.calls).toEqual([]);
    matrix.press(2, 2);
    matrix.release(2, 2);
    matrix.release(2, 2);
    expect(kb.calls).toEqual(['2,2,down', '2,2,up']);
  });

  it('does nothing when no machine is running', () => {
    const { matrix } = setup(null);
    expect(() => { matrix.press(0, 0); matrix.release(0, 0); }).not.toThrow();
    expect(matrix.isDown(0, 0)).toBe(false);
  });

  it('lets go of held cells when the pane is disposed', () => {
    const kb = new FakeKeyboard();
    const { matrix, dispose } = setup(kb);
    matrix.press(3, 4);
    dispose();
    expect(kb.calls).toEqual(['3,4,down', '3,4,up']);
  });

  it('shows an active-low cell as down when its bit clears on the next frame', () => {
    const kb = new FakeKeyboard();
    const { matrix } = setup(kb);
    expect(matrix.isDown(1, 0)).toBe(false);
    kb.rows[1] &= ~0x01;                 // a physical keystroke, not a pointer press
    frames.shift()!();
    expect(matrix.isDown(1, 0)).toBe(true);
    expect(matrix.isDown(1, 1)).toBe(false);
  });

  it('treats a set bit as down on an active-high matrix', () => {
    const kb = new FakeKeyboard();
    kb.rows.fill(0);
    const { matrix } = setup(kb, { released: 0, activeLow: false });
    kb.rows[2] |= 0x20;
    frames.shift()!();
    expect(matrix.isDown(2, 5)).toBe(true);
    expect(matrix.isDown(2, 4)).toBe(false);
  });

  it('clears the mirror when the machine goes away', () => {
    let kb: FakeKeyboard | null = new FakeKeyboard();
    const { matrix } = setup(null, { keyboard: () => kb });
    kb.rows[0] &= ~0x02;
    frames.shift()!();
    expect(matrix.isDown(0, 1)).toBe(true);
    kb = null;
    frames.shift()!();
    expect(matrix.isDown(0, 1)).toBe(false);
  });

  it('runs onFrame every frame, with null when no machine is running', () => {
    const seen: Array<FakeKeyboard | null> = [];
    const kb = new FakeKeyboard();
    setup(kb, { onFrame: (k) => seen.push(k) });
    frames.shift()!();
    expect(seen).toEqual([kb]);
  });
});

