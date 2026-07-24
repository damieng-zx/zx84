import { describe, expect, it } from 'vitest';
import {
  CPC_MAIN_ROWS,
  CPC_CURSOR_KEYS,
  CPC_NUMPAD_ROWS,
} from '@/machines/cpc/ui/keyboard/layout.ts';
import {
  CPC464_SCENE,
  placeCpc464Keys,
} from '@/machines/cpc/ui/keyboard/scene-geometry.ts';

describe('CPC 464 keyboard scene geometry', () => {
  it('places the real 74-key CPC 464 layout', () => {
    const placed = placeCpc464Keys();
    expect(placed).toHaveLength(74);
    expect(placed.filter((item) => item.region === 'main')).toHaveLength(57);
    expect(placed.filter((item) => item.region === 'cursor')).toHaveLength(5);
    expect(placed.filter((item) => item.region === 'numpad')).toHaveLength(12);
  });

  it('keeps every cap inside the fixed scene', () => {
    for (const { key, box } of placeCpc464Keys()) {
      expect(box.x, `${key.id} left`).toBeGreaterThanOrEqual(0);
      expect(box.y, `${key.id} top`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${key.id} right`).toBeLessThanOrEqual(CPC464_SCENE.width);
      expect(box.y + box.height, `${key.id} bottom`).toBeLessThanOrEqual(CPC464_SCENE.height);
    }
  });

  it('uses the measured double-height main ENTER and unequal modifier widths', () => {
    const placed = placeCpc464Keys();
    const enter = placed.find((item) => item.key.id === 'return')!;
    const letter = placed.find((item) => item.key.id === 'q')!;
    const leftShift = placed.find((item) => item.key.id === 'shift-left')!;
    const space = placed.find((item) => item.key.id === 'space')!;

    expect(enter.box.height).toBe(letter.box.height * 2 + 4);
    expect(leftShift.box.width).toBeGreaterThan(letter.box.width * 2);
    expect(space.box.width).toBeGreaterThan(letter.box.width * 8);
  });

  it('preserves the CPC punctuation pairs and matrix cells independently', () => {
    const all = [
      ...CPC_MAIN_ROWS.flatMap((row) => row.keys),
      ...CPC_CURSOR_KEYS,
      ...CPC_NUMPAD_ROWS.flat(),
    ];
    const byId = (id: string) => all.find((key) => key.id === id)!;

    expect(byId('caret')).toMatchObject({ main: '^', shift: '£', cell: [3, 0] });
    expect(byId('at')).toMatchObject({ main: '@', shift: '|', cell: [3, 2] });
    expect(byId('semicolon')).toMatchObject({ main: ';', shift: '+', cell: [3, 4] });
    expect(byId('colon')).toMatchObject({ main: ':', shift: '*', cell: [3, 5] });
    expect(byId('backslash')).toMatchObject({ main: '\\', shift: '`', cell: [2, 6] });
  });
});
