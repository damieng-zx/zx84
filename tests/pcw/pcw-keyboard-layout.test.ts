/**
 * The on-screen Amstrad PCW keyboard's key table and geometry.
 *
 * The table is hand-transcribed from a photograph of an 8256 deck, so the thing
 * worth testing is that it agrees with the machine: a cap wired to the wrong
 * matrix cell looks perfectly fine and types the wrong letter. Every cap that
 * has a host key is checked against the real `PcwKeyboard` by pressing that key
 * and watching which bit actually rises.
 *
 * The expected matrix below is transcribed from the Amstrad PCW Hardware
 * Reference's &3FF0-&3FFA table, and is deliberately NOT derived from
 * `PCW_KEYS`. Half a byte has no cap on it at all: &3FF9 b6-b0 is the joystick.
 */

import { describe, expect, it } from 'vitest';
import { PcwKeyboard, type PcwCell } from '@/machines/pcw/pcw-keyboard.ts';
import { PCW_KEYS, PCW_KEY_INDEX } from '@/machines/pcw/ui/keyboard/layout.ts';
import {
  PCW9_SCENE, PCW9_WELLS, PCW_SCENE, PCW_WELL, placePcw9Keys, placePcwKeys,
} from '@/machines/pcw/ui/keyboard/scene-geometry.ts';

/** Cells with a cap on them, `byte: bits`. &3FF9 keeps only b7 (DEL<); the
 *  rest of that byte is the joystick, which no cap reaches. */
const MATRIX: Readonly<Record<number, readonly number[]>> = {
  0x0: [0, 1, 2, 3, 4, 5, 6, 7],
  0x1: [0, 1, 2, 3, 4, 5, 6, 7],
  0x2: [0, 1, 2, 3, 4, 5, 6, 7],
  0x3: [0, 1, 2, 3, 4, 5, 6, 7],
  0x4: [0, 1, 2, 3, 4, 5, 6, 7],
  0x5: [0, 1, 2, 3, 4, 5, 6, 7],
  0x6: [0, 1, 2, 3, 4, 5, 6, 7],
  0x7: [0, 1, 2, 3, 4, 5, 6, 7],
  0x8: [0, 1, 2, 3, 4, 5, 6, 7],
  0x9: [7],
  0xA: [0, 1, 2, 3, 4, 5, 6, 7],
};

/** 81 switches under 82 caps: the two SHIFT caps are one switch. */
const SWITCHES = Object.values(MATRIX).reduce((n, bits) => n + bits.length, 0);

/** The host key each cap stands for. The word-processing caps — CAN, CUT,
 *  COPY, PASTE, PTR, EXIT and the `< §` cap — have none, so they can only be
 *  reached from the on-screen keyboard. */
const HOST_KEY: Readonly<Record<string, string>> = {
  stop: 'Escape',
  1: 'Digit1', 2: 'Digit2', 3: 'Digit3', 4: 'Digit4', 5: 'Digit5',
  6: 'Digit6', 7: 'Digit7', 8: 'Digit8', 9: 'Digit9', 0: 'Digit0',
  minus: 'Minus', equals: 'Equal',
  'del-right': 'Delete', 'del-left': 'Backspace',
  tab: 'Tab',
  q: 'KeyQ', w: 'KeyW', e: 'KeyE', r: 'KeyR', t: 'KeyT', y: 'KeyY',
  u: 'KeyU', i: 'KeyI', o: 'KeyO', p: 'KeyP',
  'bracket-left': 'BracketLeft', 'bracket-right': 'BracketRight',
  return: 'Enter',
  'shift-lock': 'CapsLock',
  a: 'KeyA', s: 'KeyS', d: 'KeyD', f: 'KeyF', g: 'KeyG', h: 'KeyH',
  j: 'KeyJ', k: 'KeyK', l: 'KeyL',
  semicolon: 'Semicolon', hash: 'Backslash',
  'shift-left': 'ShiftLeft', 'shift-right': 'ShiftRight',
  z: 'KeyZ', x: 'KeyX', c: 'KeyC', v: 'KeyV', b: 'KeyB', n: 'KeyN', m: 'KeyM',
  comma: 'Comma', period: 'Period', slash: 'Slash', half: 'Backquote',
  alt: 'ControlLeft', extra: 'AltLeft',
  'box-plus': 'NumpadAdd', space: 'Space', 'box-minus': 'NumpadSubtract',
  pad0: 'Numpad0', pad1: 'Numpad1', pad2: 'Numpad2', pad3: 'Numpad3',
  pad4: 'Numpad4', pad5: 'Numpad5', pad6: 'Numpad6', pad7: 'Numpad7',
  pad8: 'Numpad8', pad9: 'Numpad9',
  'pad-dot': 'NumpadDecimal', 'pad-enter': 'NumpadEnter',
  'f8-f7': 'F8', 'f6-f5': 'F6', 'f4-f3': 'F4', 'f2-f1': 'F2',
};

/** The eleven bytes that carry key bits; the rest are links and flags. */
const KEY_BYTES = 0x0B;

/** The single cell a host key raises, or null if it raises none or many. */
function press(code: string): PcwCell | null {
  const kb = new PcwKeyboard();
  kb.handleKeyEvent(
    { code, key: code, shift: false, ctrl: false, alt: false }, true,
  );
  const down: PcwCell[] = [];
  for (let byte = 0; byte < KEY_BYTES; byte++) {
    for (let bit = 0; bit < 8; bit++) {
      if ((kb.matrix[byte] & (1 << bit)) !== 0) down.push([byte, bit]);
    }
  }
  return down.length === 1 ? down[0] : null;
}

describe('PCW keyboard layout', () => {
  it('wires every cap to the cell its host key raises', () => {
    for (const key of PCW_KEYS) {
      const code = HOST_KEY[key.id];
      if (!code) continue;
      expect(press(code), `${key.id} (${code})`).toEqual(key.cell);
    }
  });

  it('reaches every switch the hardware has, and none it has not', () => {
    const wired = new Set<string>();
    for (const key of PCW_KEYS) wired.add(`${key.cell[0]},${key.cell[1]}`);
    const expected = new Set<string>();
    for (const [byte, bits] of Object.entries(MATRIX)) {
      for (const bit of bits) expected.add(`${Number(byte)},${bit}`);
    }
    expect([...wired].sort()).toEqual([...expected].sort());
    expect(wired.size).toBe(SWITCHES);
    expect(SWITCHES).toBe(81);
  });

  it('carries all 82 caps, with the two SHIFTs sharing one switch', () => {
    expect(PCW_KEYS).toHaveLength(SWITCHES + 1);
    expect(PCW_KEY_INDEX.get('shift-left')!.cell)
      .toEqual(PCW_KEY_INDEX.get('shift-right')!.cell);
    // Ids are what the CSS hooks onto, so they have to be unique.
    expect(PCW_KEY_INDEX.size).toBe(PCW_KEYS.length);
  });

  it('leaves the joystick bits of &3FF9 with no cap on them', () => {
    for (const key of PCW_KEYS) {
      if (key.cell[0] !== 0x9) continue;
      expect(key.cell[1], key.id).toBe(7);      // DEL< alone
    }
  });

  it('gives every cap a legend, except the space bar', () => {
    for (const key of PCW_KEYS) {
      if (key.id === 'space') { expect(key.main).toBe(''); continue; }
      expect(key.main.length, key.id).toBeGreaterThan(0);
    }
  });
});

describe('PCW keyboard: pressing a cap the host cannot reach', () => {
  it('raises and clears the cell, and lights the activity flag', () => {
    const kb = new PcwKeyboard();
    const copy = PCW_KEY_INDEX.get('copy')!.cell;
    expect(kb.isCellDown(copy)).toBe(false);
    expect(kb.anyKeyDown).toBe(false);

    kb.setCell(copy, true);
    expect(kb.isCellDown(copy)).toBe(true);
    expect(kb.anyKeyDown).toBe(true);

    kb.setCell(copy, false);
    expect(kb.isCellDown(copy)).toBe(false);
    expect(kb.anyKeyDown).toBe(false);
  });

  it('latches SHIFT LOCK rather than holding it, as the host Caps Lock does', () => {
    const kb = new PcwKeyboard();
    const lock = PCW_KEY_INDEX.get('shift-lock')!.cell;
    kb.setCell(lock, true);
    expect(kb.shiftLock).toBe(true);
    kb.setCell(lock, false);
    expect(kb.shiftLock).toBe(true);           // still locked with the cap up
    kb.setCell(lock, true);
    expect(kb.shiftLock).toBe(false);
  });

  it('will not write over the link and flag bytes', () => {
    const kb = new PcwKeyboard();
    const before = kb.matrix[0x0D];
    kb.setCell([0x0D, 0], true);
    expect(kb.matrix[0x0D]).toBe(before);
  });

  it('is cleared by a reset, matrix and activity flag together', () => {
    const kb = new PcwKeyboard();
    kb.setCell(PCW_KEY_INDEX.get('paste')!.cell, true);
    kb.reset();
    expect(kb.anyKeyDown).toBe(false);
    expect([...kb.matrix.subarray(0, KEY_BYTES)].every((b) => b === 0)).toBe(true);
  });
});

describe('PCW keyboard geometry', () => {
  const placed = placePcwKeys();
  /** 1u on this face: a 40-unit pitch with a 3-unit gap between caps. */
  const CAP_1U = 37;

  it('places one box per cap, all inside the scene', () => {
    expect(placed).toHaveLength(PCW_KEYS.length);
    for (const { key, box } of placed) {
      expect(box.x, key.id).toBeGreaterThanOrEqual(0);
      expect(box.y, key.id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, key.id).toBeLessThanOrEqual(PCW_SCENE.width);
      expect(box.y + box.height, key.id).toBeLessThanOrEqual(PCW_SCENE.height);
    }
  });

  it('has no cap under 1u, and only RETURN taller than one', () => {
    for (const { key, box } of placed) {
      expect(box.width, key.id).toBeGreaterThanOrEqual(CAP_1U);
      expect(box.height, key.id).toBe(key.id === 'return' ? 77 : CAP_1U);
    }
  });

  it('overlaps no two caps', () => {
    // RETURN is excluded: its bounding box deliberately covers the `> #` cap's
    // corner, which is the whole reason it carries a clip path. The pair is
    // checked properly in the RETURN test below.
    const boxes = placed.filter((p) => !p.hitClip);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].box;
        const b = boxes[j].box;
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x
          || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${boxes[i].key.id} overlaps ${boxes[j].key.id}`).toBe(true);
      }
    }
  });

  it('fills all 19 columns on every row, with no staircase', () => {
    const rows = new Map<number, { left: number; right: number }>();
    for (const { box } of placed) {
      // RETURN starts on row 2 and is measured there.
      const row = rows.get(box.y) ?? { left: Infinity, right: -Infinity };
      rows.set(box.y, {
        left: Math.min(row.left, box.x),
        right: Math.max(row.right, box.x + box.width),
      });
    }
    expect(rows.size).toBe(5);
    const widths = [...rows.values()];
    for (const { left, right } of widths) {
      expect(left).toBe(widths[0].left);
      expect(right).toBe(widths[0].right);
    }
  });

  it('sits the whole deck in one well', () => {
    expect(PCW_WELL.x).toBeGreaterThanOrEqual(0);
    expect(PCW_WELL.y).toBeGreaterThanOrEqual(0);
    expect(PCW_WELL.x + PCW_WELL.width).toBeLessThanOrEqual(PCW_SCENE.width);
    expect(PCW_WELL.y + PCW_WELL.height).toBeLessThanOrEqual(PCW_SCENE.height);
    for (const { key, box } of placed) {
      expect(box.x, key.id).toBeGreaterThan(PCW_WELL.x);
      expect(box.y, key.id).toBeGreaterThan(PCW_WELL.y);
      expect(box.x + box.width, key.id).toBeLessThan(PCW_WELL.x + PCW_WELL.width);
      expect(box.y + box.height, key.id)
        .toBeLessThan(PCW_WELL.y + PCW_WELL.height);
    }
  });

  it('clips RETURN alone, so its shoulder cannot steal the `> #` cap', () => {
    const clipped = placed.filter((p) => p.hitClip);
    expect(clipped).toHaveLength(1);
    const { box, hitClip } = clipped[0];
    expect(clipped[0].key.id).toBe('return');

    // The top clears the cap to its left on row 2 outright.
    const bracket = placed.find((p) => p.key.id === 'bracket-right')!.box;
    expect(box.x).toBeGreaterThanOrEqual(bracket.x + bracket.width);

    // The foot does not: only the clip keeps it off `> #`, so the step has to
    // land at or right of that cap's right edge.
    const step = /polygon\(0 0, 100% 0, 100% 100%, ([\d.]+)%/.exec(hitClip!);
    expect(step, hitClip).not.toBeNull();
    const footLeft = box.x + box.width * Number(step![1]) / 100;
    const hash = placed.find((p) => p.key.id === 'hash')!.box;
    expect(footLeft).toBeGreaterThanOrEqual(hash.x + hash.width);
  });
});

/**
 * The 9512/9256 deck. It carries the same 82 caps as the 8256's, so the tests
 * that matter are that none of them went missing in the rearrangement, that
 * the blocks really are separated by case, and that every cap landed in a well.
 */
describe('PCW 9000-series keyboard geometry', () => {
  const placed = placePcw9Keys();
  const CAP_1U = 37;
  /** A cap is one column left of the next: the blocks are further apart. */
  const BLOCK_GAP = 40;

  it('places the same 82 caps as the 8000s, each inside the scene', () => {
    expect(placed.map((p) => p.key.id).sort())
      .toEqual(placePcwKeys().map((p) => p.key.id).sort());
    for (const { key, box } of placed) {
      expect(box.x, key.id).toBeGreaterThanOrEqual(0);
      expect(box.y, key.id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, key.id).toBeLessThanOrEqual(PCW9_SCENE.width);
      expect(box.y + box.height, key.id).toBeLessThanOrEqual(PCW9_SCENE.height);
    }
  });

  it('has no cap under 1u, and only RETURN taller than one', () => {
    for (const { key, box } of placed) {
      expect(box.width, key.id).toBeGreaterThanOrEqual(CAP_1U);
      expect(box.height, key.id).toBe(key.id === 'return' ? 77 : CAP_1U);
    }
  });

  it('overlaps no two caps', () => {
    const boxes = placed.filter((p) => !p.hitClip);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].box;
        const b = boxes[j].box;
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x
          || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${boxes[i].key.id} overlaps ${boxes[j].key.id}`).toBe(true);
      }
    }
  });

  it('stands the function keys and the pad clear of the typewriter block', () => {
    const span = (ids: readonly string[]) => {
      const boxes = ids.map((id) => placed.find((p) => p.key.id === id)!.box);
      return {
        left: Math.min(...boxes.map((b) => b.x)),
        right: Math.max(...boxes.map((b) => b.x + b.width)),
      };
    };
    const left = span(['f8-f7', 'f2-f1', 'can', 'ptr', 'alt', 'extra',
      'box-plus', 'box-minus']);
    const main = span(['stop', 'tab', 'shift-lock', 'shift-left', 'space',
      'return', 'shift-right', 'exit', 'del-left']);
    const pad = span(['cut', 'copy', 'paste', 'pad7', 'pad0', 'pad-enter']);

    expect(main.left - left.right).toBeGreaterThanOrEqual(BLOCK_GAP);
    expect(pad.left - main.right).toBeGreaterThanOrEqual(BLOCK_GAP);
  });

  it('drops every cap into one of the wells', () => {
    for (const { key, box } of placed) {
      const held = PCW9_WELLS.some((well) => box.x > well.x
        && box.y > well.y
        && box.x + box.width < well.x + well.width
        && box.y + box.height < well.y + well.height);
      expect(held, key.id).toBe(true);
    }
    for (const well of PCW9_WELLS) {
      expect(well.x).toBeGreaterThanOrEqual(0);
      expect(well.x + well.width).toBeLessThanOrEqual(PCW9_SCENE.width);
      expect(well.y + well.height).toBeLessThanOrEqual(PCW9_SCENE.height);
    }
  });

  it('laps the middle well rectangles, so the step shows no seam', () => {
    // They are drawn with a 2-unit corner radius; anything less than that much
    // overlap and the rounded corners would bite into the join.
    const [, upper, lower] = PCW9_WELLS;
    expect(upper.y + upper.height - lower.y).toBeGreaterThanOrEqual(4);
    expect(lower.x).toBeGreaterThan(upper.x);
    expect(lower.x + lower.width).toBeLessThan(upper.x + upper.width);
  });

  it('prints SPCHK on the pad 2 cap, not the 8000s page symbol', () => {
    expect(placed.find((p) => p.key.id === 'pad2')!.key.fn).toBe('SPCHK');
    expect(placePcwKeys().find((p) => p.key.id === 'pad2')!.key.fn).not.toBe('SPCHK');
  });
});
