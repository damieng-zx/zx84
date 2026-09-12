/**
 * Jupiter Ace on-screen keyboard layout.
 *
 * Expectations are derived independently of the implementation:
 *   • key cells and SYMBOL SHIFT characters come from the Ace ROM's own
 *     key-decode tables — unshifted at 0x0376, SYMBOL SHIFT at 0x03C6, both
 *     40 bytes indexed (4 - bit) * 8 + (7 - row) — transcribed below;
 *   • the SHIFT functions and key positions come from the Ace user manual
 *     (chapter 2) and the Micro Choice review (Winter 1983).
 */

import { describe, expect, it } from 'vitest';
import { ACE_ROWS, SHIFT, SYMBOL_SHIFT } from '@/machines/jupiter-ace/ui/keyboard/legends.ts';
import { ACE_SCENE, placeAceRows } from '@/machines/jupiter-ace/ui/keyboard/scene-geometry.ts';
import { aceKeyboardLabPresets } from '@/machines/jupiter-ace/ui/keyboard/lab-preset.ts';
import { AceKeyboard } from '@/machines/jupiter-ace/keyboard.ts';
import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';

// ROM 0x0376: unshifted key → character (0x00 marks the two modifiers).
const ROM_KEY_TABLE = 'vhy65tgc' + 'bju74rfx' + 'nki83edz' + 'mlo92ws\0' + ' \rp01qa\0';

// ROM 0x03C6: SYMBOL SHIFT + key → character code.
const ROM_SYMBOL_TABLE = [
  0x2f, 0x5e, 0x5b, 0x26, 0x25, 0x3e, 0x7d, 0x3f, // bit 4, rows 7..0
  0x2a, 0x2d, 0x5d, 0x27, 0x24, 0x3c, 0x7b, 0x60, // bit 3
  0x2c, 0x2b, 0x7f, 0x28, 0x23, 0x45, 0x5c, 0x3a, // bit 2
  0x2e, 0x3d, 0x3b, 0x29, 0x40, 0x57, 0x7c, 0x00, // bit 1
  0x20, 0x0d, 0x22, 0x5f, 0x21, 0x51, 0x7e, 0x00, // bit 0
];

/** The Ace character set's non-ASCII glyphs (shared with the Spectrum). */
const ACE_GLYPH: Record<number, string> = { 0x5e: '↑', 0x60: '£', 0x7f: '©' };

const romIndex = ([row, bit]: readonly [number, number]) => (4 - bit) * 8 + (7 - row);

const keys = ACE_ROWS.flat();
const byMain = new Map(keys.map((k) => [k.main, k]));

function expectWithin(box: SceneBox) {
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(ACE_SCENE.width);
  expect(box.y + box.height).toBeLessThanOrEqual(ACE_SCENE.height);
}

describe('Jupiter Ace on-screen layout', () => {
  it('covers all 40 matrix cells exactly once', () => {
    const all: string[] = [];
    for (let row = 0; row < 8; row++) for (let bit = 0; bit < 5; bit++) all.push(`${row},${bit}`);
    expect(keys.map((k) => `${k.pos[0]},${k.pos[1]}`).sort()).toEqual(all.sort());
  });

  it('is four rows of ten keys', () => {
    expect(ACE_ROWS.map((r) => r.length)).toEqual([10, 10, 10, 10]);
  });

  it('puts every key on the cell the ROM decodes to its own character', () => {
    const special: Record<string, string> = {
      ENTER: '\r', 'BREAK\nSPACE': ' ', SHIFT: '\0', 'SYMBOL\nSHIFT': '\0',
    };
    for (const k of keys) {
      const expected = special[k.main] ?? k.main.toLowerCase();
      expect(ROM_KEY_TABLE[romIndex(k.pos)], k.main).toBe(expected);
    }
  });

  it("prints the ROM's SYMBOL SHIFT character on every key that has one", () => {
    for (const k of keys.filter((key) => key.kind !== 'special')) {
      const code = ROM_SYMBOL_TABLE[romIndex(k.pos)];
      // Q, W and E decode to their own capital — no symbol printed.
      const expected = code === k.main.charCodeAt(0)
        ? undefined
        : ACE_GLYPH[code] ?? String.fromCharCode(code);
      expect(k.symbol, k.main).toBe(expected);
    }
  });

  it('puts SHIFT bottom-left and SYMBOL SHIFT next to SPACE, as on the Spectrum', () => {
    expect(ACE_ROWS[3].map((k) => k.main)).toEqual([
      'SHIFT', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'SYMBOL\nSHIFT', 'BREAK\nSPACE',
    ]);
    expect(ACE_ROWS[2][9].main).toBe('ENTER');
  });

  it('latches only SHIFT and SYMBOL SHIFT', () => {
    expect(keys.filter((k) => k.latch).map((k) => k.pos)).toEqual([SHIFT, SYMBOL_SHIFT]);
  });

  it("prints the manual's SHIFT functions below the digits (SHIFT+6 is cursor up)", () => {
    const fn = (d: string) => byMain.get(d)?.shiftFn?.replace('\n', ' ');
    expect([...'1234567890'].map(fn)).toEqual([
      'DELETE LINE', 'CAPS LOCK', undefined, 'INVERSE VIDEO',
      '←', '↑', '↓', '→', 'GRAPHICS', 'DELETE',
    ]);
  });

  it("prints the ROM's GRAPHICS-mode block on digits 1-7 and 0 only", () => {
    // Booting the ROM in GRAPHICS mode: digit d types code d − 0x20, whose
    // generated glyph lights top-left (bit 1), top-right (bit 0) and
    // bottom-right (bit 2). 0 → 0x10 is the empty block; 8 and 9 (0x18,
    // 0x19) merely repeat 0's and 1's. Quadrants: [TL, TR, BL, BR].
    const expected: Record<string, readonly number[] | undefined> = {
      '1': [0, 1, 0, 0], '2': [1, 0, 0, 0], '3': [1, 1, 0, 0], '4': [0, 0, 0, 1],
      '5': [0, 1, 0, 1], '6': [1, 0, 0, 1], '7': [1, 1, 0, 1], '8': undefined,
      '9': undefined, '0': [0, 0, 0, 0],
    };
    for (const [digit, graphic] of Object.entries(expected)) {
      expect(byMain.get(digit)?.graphic, digit).toEqual(graphic);
    }
    expect(keys.filter((k) => k.kind !== 'num').every((k) => k.graphic === undefined)).toBe(true);
  });

  it('the modifier cells are the ones the emulated SHIFT / SYMBOL SHIFT press', () => {
    const kb = new AceKeyboard();
    kb.handleKeyEvent('ShiftLeft', true);
    kb.handleKeyEvent('ControlLeft', true);
    expect(kb.rows[SHIFT[0]] & (1 << SHIFT[1])).toBe(0);
    expect(kb.rows[SYMBOL_SHIFT[0]] & (1 << SYMBOL_SHIFT[1])).toBe(0);
  });
});

describe('Jupiter Ace scene geometry', () => {
  const placed = placeAceRows(ACE_ROWS);

  it('places every cap and case legend inside the scene', () => {
    expect(placed).toHaveLength(40);
    for (const p of placed) {
      expectWithin(p.cap);
      if (p.below) expectWithin(p.below);
    }
  });

  // A 1u key is square at the Spectrum 48K's cap height (42 × 52/72), with a
  // 10-unit gap: pitch = 30⅓ + 10 = 40⅓.
  const SIZE = 42 * 52 / 72;
  const PITCH = SIZE + 10;

  it('makes every 1u key square', () => {
    for (const p of placed.filter((q) => (q.key.w ?? 1) === 1)) {
      expect(p.cap.width, p.key.main).toBeCloseTo(SIZE);
      expect(p.cap.height, p.key.main).toBeCloseTo(SIZE);
    }
  });

  it("keeps the Spectrum 48K's stagger and wide SHIFT / SPACE at the square pitch", () => {
    expect(placed[0].cap.x).toBeCloseTo(12);
    expect(placed[10].cap.x).toBeCloseTo(12 + PITCH / 2);        // Q row: half-pitch
    expect(placed[20].cap.x).toBeCloseTo(12 + PITCH * 36 / 52);  // A row: 36/52 pitch
    expect(placed[30].cap.width).toBeCloseTo(1.25 * PITCH - 10); // SHIFT
    expect(placed[39].cap.width).toBeCloseTo(1.75 * PITCH - 10); // BREAK SPACE
    // The bottom row spans 11u and sets the scene width, with a 12-unit margin.
    expect(placed[39].cap.x + placed[39].cap.width).toBeCloseTo(12 + 11 * PITCH - 10);
    expect(ACE_SCENE.width).toBeCloseTo(12 + 11 * PITCH - 10 + 12);
  });

  it('gives only the digit row a case-legend box, in the gap below its cap', () => {
    placed.forEach((p, i) => {
      if (i >= 10) {
        expect(p.below).toBeNull();
        return;
      }
      expect(p.below!.y).toBeGreaterThanOrEqual(p.cap.y + p.cap.height);
      expect(p.below!.y + p.below!.height).toBeLessThanOrEqual(placed[10].cap.y);
    });
  });

  it('spaces all four rows equally', () => {
    const tops = [0, 10, 20, 30].map((i) => placed[i].cap.y);
    const pitch = tops[1] - tops[0];
    expect(tops[2] - tops[1]).toBeCloseTo(pitch);
    expect(tops[3] - tops[2]).toBeCloseTo(pitch);
  });
});

describe('Jupiter Ace keyboard lab preset', () => {
  it('keeps all 40 keys with unique ids inside the scene', () => {
    const [preset] = aceKeyboardLabPresets();
    expect(preset.keys).toHaveLength(40);
    expect(new Set(preset.keys.map((k) => k.id)).size).toBe(40);
    for (const k of preset.keys) expectWithin(k.box);
  });
});
