/**
 * The on-screen Camputers Lynx keyboard's key table and geometry.
 *
 * The table is hand-transcribed from a photograph of a Lynx 48K, so the thing
 * worth testing is that it agrees with the machine: a cap wired to the wrong
 * matrix cell looks perfectly fine and types the wrong letter. Every cap that
 * has a host key is therefore checked against the real `LynxKeyboard` by
 * pressing that key and watching which bit actually falls.
 *
 * The expected matrix below is transcribed independently, from MAME's
 * `camputers/camplynx.cpp` LINE0-LINE9 port table plus the MiSTer Lynx48
 * core's `rtl/keyboard.v`, which names the one cell MAME leaves blank
 * (SHIFT LOCK at [0,3]). It is deliberately NOT derived from `LYNX_KEYS`.
 */

import { describe, expect, it } from 'vitest';
import { LynxKeyboard } from '@/machines/lynx/lynx-keyboard.ts';
import { LYNX_KEYS, LYNX_KEY_INDEX } from '@/machines/lynx/ui/keyboard/layout.ts';
import {
  LYNX_SCENE, LYNX_WELLS, placeLynxKeys,
} from '@/machines/lynx/ui/keyboard/scene-geometry.ts';

/** The switches the hardware actually has, `line: bits`. [9,4] is left out:
 *  it is wired but no cap on the deck reaches it. */
const MATRIX: Readonly<Record<number, readonly number[]>> = {
  0: [0, 3, 4, 5, 6, 7],
  1: [0, 1, 2, 3, 4, 5],
  2: [0, 1, 2, 3, 4, 5, 6],
  3: [0, 1, 2, 3, 4, 5],
  4: [0, 1, 2, 3, 4, 5],
  5: [0, 1, 2, 3, 5],
  6: [0, 1, 2, 3, 5],
  7: [0, 1, 2, 3, 5],
  8: [0, 1, 2, 3, 5],
  9: [0, 1, 2, 3, 5],
};

/** 56 switches under 58 caps: BREAK reaches none, and both SHIFTs are one. */
const SWITCHES = Object.values(MATRIX).reduce((n, bits) => n + bits.length, 0);

/** The host key each cap stands for. Only BREAK has none. */
const HOST_KEY: Readonly<Record<string, string>> = {
  esc: 'Escape',
  1: 'Digit1', 2: 'Digit2', 3: 'Digit3', 4: 'Digit4', 5: 'Digit5',
  6: 'Digit6', 7: 'Digit7', 8: 'Digit8', 9: 'Digit9', 0: 'Digit0',
  minus: 'Minus', at: 'Equal',
  control: 'ControlLeft',
  q: 'KeyQ', w: 'KeyW', e: 'KeyE', r: 'KeyR', t: 'KeyT', y: 'KeyY',
  u: 'KeyU', i: 'KeyI', o: 'KeyO', p: 'KeyP',
  'bracket-left': 'BracketLeft', 'bracket-right': 'BracketRight',
  delete: 'Backspace',
  down: 'ArrowDown', up: 'ArrowUp',
  a: 'KeyA', s: 'KeyS', d: 'KeyD', f: 'KeyF', g: 'KeyG', h: 'KeyH',
  j: 'KeyJ', k: 'KeyK', l: 'KeyL',
  semicolon: 'Semicolon', colon: 'Quote',
  left: 'ArrowLeft', right: 'ArrowRight',
  'shift-lock': 'CapsLock',
  'shift-left': 'ShiftLeft', 'shift-right': 'ShiftRight',
  z: 'KeyZ', x: 'KeyX', c: 'KeyC', v: 'KeyV', b: 'KeyB', n: 'KeyN', m: 'KeyM',
  comma: 'Comma', period: 'Period', slash: 'Slash',
  return: 'Enter',
  space: 'Space',
};

/** The single cell a host key pulls low, or null if it pulls none or many. */
function press(code: string): [number, number] | null {
  const kb = new LynxKeyboard();
  kb.handleKeyEvent(code, true);
  const down: [number, number][] = [];
  for (let line = 0; line < 10; line++) {
    for (let bit = 0; bit < 8; bit++) {
      if ((kb.rows[line] & (1 << bit)) === 0) down.push([line, bit]);
    }
  }
  return down.length === 1 ? down[0] : null;
}

describe('Lynx keyboard layout', () => {
  it('wires every cap to the cell its host key pulls low', () => {
    for (const key of LYNX_KEYS) {
      const code = HOST_KEY[key.id];
      if (!code) continue;
      expect(press(code), `${key.id} (${code})`).toEqual(key.cell);
    }
  });

  it('gives a host key to every cap that is a switch', () => {
    for (const key of LYNX_KEYS) {
      expect(key.cell === null || HOST_KEY[key.id] !== undefined, key.id).toBe(true);
    }
  });

  it('reaches every switch the hardware has, and none it has not', () => {
    const wired = new Set<string>();
    for (const key of LYNX_KEYS) {
      if (key.cell) wired.add(`${key.cell[0]},${key.cell[1]}`);
    }
    const expected = new Set<string>();
    for (const [line, bits] of Object.entries(MATRIX)) {
      for (const bit of bits) expected.add(`${line},${bit}`);
    }
    expect([...wired].sort()).toEqual([...expected].sort());
    expect(wired.size).toBe(SWITCHES);
    expect(SWITCHES).toBe(56);
  });

  it('leaves BREAK off the matrix and pairs the two SHIFT caps', () => {
    // BREAK pulls the CPU's interrupt line, not a sense bit.
    expect(LYNX_KEY_INDEX.get('break')!.cell).toBeNull();
    // One switch, two caps: pressing either has to light both.
    expect(LYNX_KEY_INDEX.get('shift-left')!.cell)
      .toEqual(LYNX_KEY_INDEX.get('shift-right')!.cell);
    // 58 caps over 56 switches: BREAK adds one, the second SHIFT shares one.
    expect(LYNX_KEYS.length).toBe(SWITCHES + 2);
  });

  it('prints SHIFT LOCK on the cell MAME leaves unnamed', () => {
    expect(LYNX_KEY_INDEX.get('shift-lock')!.cell).toEqual([0, 3]);
  });
});

describe('Lynx keyboard geometry', () => {
  const placed = placeLynxKeys();
  /** 1u on this face: a 40-unit pitch with a 2-unit gap between caps. */
  const CAP_1U = 38;
  const DECK_CENTRE = LYNX_SCENE.width / 2;

  it('places one box per cap, all inside the scene', () => {
    expect(placed).toHaveLength(LYNX_KEYS.length);
    for (const { key, box } of placed) {
      expect(box.x, key.id).toBeGreaterThanOrEqual(0);
      expect(box.y, key.id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, key.id).toBeLessThanOrEqual(LYNX_SCENE.width);
      expect(box.y + box.height, key.id).toBeLessThanOrEqual(LYNX_SCENE.height);
    }
  });

  it('has no cap under 1u and no cap shorter than one', () => {
    for (const { key, box } of placed) {
      expect(box.width, key.id).toBeGreaterThanOrEqual(CAP_1U);
      expect(box.height, key.id).toBe(CAP_1U);
    }
  });

  it('centres every row on the deck, which is what makes the staircase', () => {
    const rows = new Map<number, { left: number; right: number }>();
    for (const { box } of placed) {
      const row = rows.get(box.y) ?? { left: Infinity, right: -Infinity };
      rows.set(box.y, {
        left: Math.min(row.left, box.x),
        right: Math.max(row.right, box.x + box.width),
      });
    }
    // Four deck rows and the space bar in the case front.
    expect(rows.size).toBe(5);
    for (const [y, { left, right }] of rows) {
      // The cell a cap sits in extends half a gap past it on either side.
      expect((left - 1 + right + 1) / 2, `row at y=${y}`).toBe(DECK_CENTRE);
    }
  });

  it('steps each row a quarter unit out from the one above', () => {
    const startOf = (id: string) => placed.find((p) => p.key.id === id)!.box.x;
    expect(startOf('esc')).toBe(startOf('control'));          // 14.5u, flush
    expect(startOf('down')).toBe(startOf('esc') - 10);        // 15u
    expect(startOf('shift-lock')).toBe(startOf('down') - 20); // 16u
  });

  it('drops the space bar clear of the deck, in its own well', () => {
    const shift = placed.find((p) => p.key.id === 'shift-lock')!.box;
    const space = placed.find((p) => p.key.id === 'space')!.box;
    expect(space.y).toBeGreaterThan(shift.y + shift.height);
    expect(space.width).toBe(8 * 40 - 2);
    // Every well is inside the scene, and the last one holds the space bar.
    for (const well of LYNX_WELLS) {
      expect(well.x).toBeGreaterThanOrEqual(0);
      expect(well.x + well.width).toBeLessThanOrEqual(LYNX_SCENE.width);
      expect(well.y + well.height).toBeLessThanOrEqual(LYNX_SCENE.height);
    }
    // The space bar's well is the only one with a foot of its own — the four
    // deck rows share one — so it is the only one that can lose its bottom
    // edge and leave the bar sitting on the case.
    const bar = LYNX_WELLS[LYNX_WELLS.length - 1];
    const pad = space.x - bar.x;
    expect(pad).toBeGreaterThan(0);
    expect(bar.x + bar.width - (space.x + space.width)).toBe(pad);
    expect(space.y - bar.y).toBe(pad);
    expect(bar.y + bar.height - (space.y + space.height)).toBe(pad);
  });
});
