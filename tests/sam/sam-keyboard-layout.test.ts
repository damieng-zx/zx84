/**
 * The on-screen SAM keyboard's key table and geometry.
 *
 * The table is hand-transcribed from a photograph, so the thing worth testing
 * is that it agrees with the machine: a cap wired to the wrong matrix cell
 * looks perfectly fine and types the wrong letter. The letters and digits are
 * therefore checked against the real `SamKeyboard` by pressing the host key
 * they stand for and watching which bit actually falls.
 */

import { describe, expect, it } from 'vitest';
import { SamKeyboard } from '@/machines/sam/sam-keyboard.ts';
import { SAM_KEYS, SAM_KEY_INDEX } from '@/machines/sam/ui/keyboard/layout.ts';
import { placeSamKeys, SAM_SCENE } from '@/machines/sam/ui/keyboard/scene-geometry.ts';

/** The matrix the SAM actually has: eight bits on rows 0-7, five on row 8. */
const TOTAL_KEYS = 8 * 8 + 5;

function press(kb: SamKeyboard, code: string, key: string): [number, number] | null {
  kb.reset();
  kb.handleKeyEvent({ code, key, shift: false, ctrl: false, alt: false }, true);
  for (let row = 0; row < 9; row++) {
    for (let bit = 0; bit < 8; bit++) {
      if ((kb.rows[row] & (1 << bit)) === 0) return [row, bit];
    }
  }
  return null;
}

/** The corners of a `polygon()` clip path, as fractions of the cap. */
function clipPoints(clip: string): number[][] {
  return clip.replace(/^polygon\(|\)$/g, '').split(',')
    .map(point => point.trim().split(/\s+/).map(v => parseFloat(v) / 100));
}

describe('SAM keyboard layout', () => {
  it('covers every matrix position exactly once', () => {
    const cells = new Set(SAM_KEYS.map(k => `${k.cell[0]},${k.cell[1]}`));
    expect(cells.size).toBe(TOTAL_KEYS);
    // 69 keys is the count the Technical Manual quotes.
    expect(TOTAL_KEYS).toBe(69);
  });

  it('stays inside the matrix the machine has', () => {
    for (const k of SAM_KEYS) {
      const [row, bit] = k.cell;
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(9);
      expect(bit).toBeGreaterThanOrEqual(0);
      // Row 8 holds only CNTRL and the four cursor keys.
      expect(bit).toBeLessThan(row === 8 ? 5 : 8);
    }
  });

  it('gives each duplicated cap the same cell as its partner', () => {
    // Three switches carry two caps: SHIFT and SYMBOL at both ends of their
    // rows, and the full stop, which the keypad repeats. Pressing either cap
    // has to light both.
    expect(SAM_KEY_INDEX.get('shift-right')!.cell)
      .toEqual(SAM_KEY_INDEX.get('shift')!.cell);
    expect(SAM_KEY_INDEX.get('symbol-right')!.cell)
      .toEqual(SAM_KEY_INDEX.get('symbol')!.cell);
    expect(SAM_KEY_INDEX.get('period-keypad')!.cell)
      .toEqual(SAM_KEY_INDEX.get('period')!.cell);
  });

  it('has three more caps than switches', () => {
    expect(SAM_KEYS.length).toBe(TOTAL_KEYS + 3);
  });

  it('names every key once', () => {
    const ids = SAM_KEYS.map(k => k.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['a', 'KeyA'], ['z', 'KeyZ'], ['m', 'KeyM'], ['q', 'KeyQ'], ['p', 'KeyP'],
    ['l', 'KeyL'], ['h', 'KeyH'], ['x', 'KeyX'], ['f', 'KeyF'], ['g', 'KeyG'],
    ['t', 'KeyT'], ['r', 'KeyR'], ['b', 'KeyB'], ['v', 'KeyV'], ['y', 'KeyY'],
    ['0', 'Digit0'], ['1', 'Digit1'], ['5', 'Digit5'], ['6', 'Digit6'],
    ['9', 'Digit9'],
  ])('puts %s where the machine puts it', (id, code) => {
    const kb = new SamKeyboard();
    const cell = press(kb, code, id);
    expect(cell).toEqual([...SAM_KEY_INDEX.get(id)!.cell]);
  });

  it.each([
    ['esc', 'Escape'], ['tab', 'Tab'], ['caps', 'CapsLock'],
    ['delete', 'Backspace'], ['return', 'Enter'], ['space', 'Space'],
    ['edit', 'Home'], ['cntrl', 'ControlRight'],
    ['up', 'ArrowUp'], ['down', 'ArrowDown'],
    ['left', 'ArrowLeft'], ['right', 'ArrowRight'],
  ])('puts the %s key where the machine puts it', (id, code) => {
    const kb = new SamKeyboard();
    expect(press(kb, code, code)).toEqual([...SAM_KEY_INDEX.get(id)!.cell]);
  });

  it('places every key, and only keys that exist', () => {
    const placed = placeSamKeys();
    expect(placed).toHaveLength(SAM_KEYS.length);
    expect(new Set(placed.map(p => p.key.id)).size).toBe(SAM_KEYS.length);
  });

  it('keeps every cap inside the case', () => {
    for (const { key, box } of placeSamKeys()) {
      expect(box.x, key.id).toBeGreaterThanOrEqual(0);
      expect(box.y, key.id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, key.id).toBeLessThanOrEqual(SAM_SCENE.width);
      expect(box.y + box.height, key.id).toBeLessThanOrEqual(SAM_SCENE.height);
    }
  });

  it('does not overlap two caps', () => {
    // RETURN is the exception: its bounding box covers the notch beside the
    // `"` cap, and only the clip path keeps them apart.
    const placed = placeSamKeys().filter(p => p.key.id !== 'return');
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i].box, b = placed[j].box;
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x
          || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${placed[i].key.id} overlaps ${placed[j].key.id}`).toBe(true);
      }
    }
  });

  /**
   * Every row is the same width, and the keypad butts straight up against it.
   * Getting the first row's key count wrong (it has twelve unit keys, not
   * thirteen) stretched every other row to match a column that is not there,
   * and opened a channel of bare case in front of the function keys.
   */
  it('lines every row up and puts the keypad flush against them', () => {
    const placed = placeSamKeys();
    const rightEdge = (y: number) => Math.max(
      ...placed.filter(p => p.box.y === y && p.box.x < 600)
        .map(p => p.box.x + p.box.width));
    const rows = [...new Set(placed.map(p => p.box.y))].sort((a, b) => a - b);
    const edges = rows.map(rightEdge);
    for (const edge of edges) expect(edge).toBe(edges[0]);

    // The first keypad column starts one ordinary key gap after that edge.
    const keypadLeft = Math.min(...placed
      .filter(p => p.box.x > edges[0]).map(p => p.box.x));
    expect(keypadLeft - edges[0]).toBeLessThanOrEqual(4);
  });

  /**
   * The bottom row takes its measurements from the row above rather than from
   * the photograph: SPACE runs from X's left edge to the full stop's right
   * edge, and SYMBOL is a CAPS-width cap. Sized on their own the two rows
   * drifted out of step with each other.
   */
  it('lines the space bar up with X and the full stop', () => {
    const placed = placeSamKeys();
    const at = (id: string) => placed.find(p => p.key.id === id)!.box;

    expect(at('space').x).toBe(at('x').x);
    expect(at('space').x + at('space').width)
      .toBe(at('period').x + at('period').width);
    expect(at('symbol').width).toBe(at('caps').width);
    // EDIT picks up where the full stop leaves off, mirroring CNTRL.
    expect(at('edit').x).toBe(at('period').x + at('period').width + 4);
    expect(at('edit').width).toBe(at('cntrl').width);
    expect(at('symbol-right').width).toBe(at('symbol').width);
  });

  it('cuts RETURN into an L rather than a rectangle', () => {
    const ret = placeSamKeys().find(p => p.key.id === 'return')!;
    expect(ret.hitClip).toContain('polygon');
    // Two rows tall: the Q row and the A row.
    expect(ret.box.height).toBeGreaterThan(SAM_SCENE.height / 5);
  });

  /**
   * RETURN is flush top and bottom with the caps either side of it, and the
   * notch cuts down a whole row pitch rather than half the box — so the foot
   * is exactly one cap tall and the gap between the two rows belongs to the
   * narrow upper part, where the `"` cap needs it.
   */
  it('lines RETURN up with the rows it spans, and cuts one cap off the foot', () => {
    const placed = placeSamKeys();
    const ret = placed.find(p => p.key.id === 'return')!;
    const q = placed.find(p => p.key.id === 'q')!;
    const a = placed.find(p => p.key.id === 'a')!;

    expect(ret.box.y).toBe(q.box.y);
    expect(ret.box.height).toBe(80);

    const notchY = clipPoints(ret.hitClip!)[4][1];
    // The clip path carries the cut as a rounded percentage, so compare to
    // within a rendered pixel rather than exactly.
    expect(ret.box.y + notchY * ret.box.height).toBeCloseTo(a.box.y, 2);
  });

  /** The notch is exactly as wide as the `"` cap it makes room for: wider
   *  leaves a slot of bare case beside the quote key, narrower paints over
   *  it. */
  it('stops the notch at the right edge of the `"` cap', () => {
    const placed = placeSamKeys();
    const ret = placed.find(p => p.key.id === 'return')!;
    const quotes = placed.find(p => p.key.id === 'quotes')!;

    const notchX = clipPoints(ret.hitClip!)[0][0];
    expect(ret.box.x + notchX * ret.box.width)
      .toBeCloseTo(quotes.box.x + quotes.box.width + 4, 2);
  });
});
