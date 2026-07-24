/**
 * Scene geometry is measured independently from the renderer. These tests pin
 * the physical coordinate systems so a later styling change cannot silently
 * reintroduce flex-layout drift or uniform-key assumptions.
 */

import { describe, expect, it } from 'vitest';
import {
  RUBBER_SCENE,
  hardScene,
  placeHardRows,
  placeRubberRows,
  type RubberGeometryKey,
} from '@/machines/spectrum/ui/keyboard/scene-geometry.ts';
import {
  placeZx8xRows,
  zx8xScene,
} from '@/machines/zx8x/ui/keyboard/scene-geometry.ts';
import { ZX80_ROWS, ZX81_ROWS } from '@/machines/zx8x/ui/keyboard/legends.ts';
import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';

function expectWithin(box: SceneBox, width: number, height: number) {
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
}

describe('Spectrum rubber scene', () => {
  const regular = () => ({ kind: 'letter' as const });
  const rows: RubberGeometryKey[][] = [
    Array.from({ length: 10 }, () => ({ kind: 'num' as const })),
    Array.from({ length: 10 }, regular),
    Array.from({ length: 10 }, regular),
    [
      { kind: 'special' as const, w: 1.25 },
      ...Array.from({ length: 7 }, regular),
      { kind: 'special' as const },
      { kind: 'special' as const, w: 1.75 },
    ],
  ];
  const placed = placeRubberRows(rows);

  it('places all 40 physical keys in one fixed design canvas', () => {
    expect(placed).toHaveLength(40);
    for (const key of placed) {
      expectWithin(key.above, RUBBER_SCENE.width, RUBBER_SCENE.height);
      expectWithin(key.cap, RUBBER_SCENE.width, RUBBER_SCENE.height);
      expectWithin(key.below, RUBBER_SCENE.width, RUBBER_SCENE.height);
    }
  });

  it('preserves row staggering and the real unequal bottom-row widths', () => {
    expect(placed[0].cap).toMatchObject({ x: 12, y: 34, width: 42 });
    expect(placed[10].cap.x).toBe(38);    // Q row: half-pitch stagger
    expect(placed[20].cap.x).toBe(48);    // A row: larger stagger
    expect(placed[30].cap.width).toBe(55); // 1.25u CAPS SHIFT
    expect(placed[39].cap.width).toBe(81); // 1.75u BREAK/SPACE
    expect(placed[39].cap.x + placed[39].cap.width).toBe(574);
  });

  it('models case legends as independent regions outside each cap', () => {
    for (const key of placed) {
      expect(key.above.y + key.above.height).toBe(key.cap.y);
      expect(key.below.y).toBeCloseTo(key.cap.y + key.cap.height + 2);
    }
  });
});

describe('Spectrum hard-key scenes', () => {
  interface FakeKey {
    variant: 'regular' | 'enter';
    w: number;
  }
  const rows: FakeKey[][] = [
    [{ variant: 'regular', w: 13.5 }],
    [{ variant: 'regular', w: 12.5 }, { variant: 'enter', w: 1 }],
    [{ variant: 'regular', w: 11.75 }],
    [{ variant: 'regular', w: 13.5 }],
    [{ variant: 'regular', w: 13.5 }],
  ];
  const widthOf = (key: FakeKey) => key.w;

  it('uses one L-shaped ENTER object rather than separate stem and foot keys', () => {
    const placed = placeHardRows(rows, 'toastrack', widthOf);
    expect(placed.filter((p) => p.key.variant === 'enter')).toHaveLength(1);
    expect(placed.find((p) => p.key.variant === 'enter')?.cap).toEqual({
      x: 571,
      y: 54,
      width: 82,
      height: 94,
    });
  });

  it('keeps separate measured geometry for the sparse Amstrad face', () => {
    const scene = hardScene('sparse');
    const placed = placeHardRows(rows, 'sparse', widthOf);
    const enter = placed.find((p) => p.key.variant === 'enter')!;
    expect(enter.cap).toEqual({
      x: 583.25,
      y: 56,
      width: 82.75,
      height: 96,
    });
    for (const key of placed) expectWithin(key.cap, scene.width, scene.height);
  });
});

describe('ZX80/ZX81 scenes', () => {
  it('places all 40 keys and their independent case legends', () => {
    const scene = zx8xScene('zx81');
    const placed = placeZx8xRows(ZX81_ROWS, 'zx81');
    expect(placed).toHaveLength(40);
    for (const key of placed) {
      expectWithin(key.above, scene.width, scene.height);
      expectWithin(key.cap, scene.width, scene.height);
      expectWithin(key.below, scene.width, scene.height);
      expect(key.above.y + key.above.height).toBeLessThan(key.cap.y);
      expect(key.below.y).toBeGreaterThan(key.cap.y + key.cap.height);
    }
  });

  it('pins the real stagger instead of deriving it from a generic row model', () => {
    const placed = placeZx8xRows(ZX81_ROWS, 'zx81');
    expect(placed[0].cap.x).toBe(14);
    expect(placed[10].cap.x).toBe(38);
    expect(placed[20].cap.x).toBe(48.5);
    expect(placed[30].cap.x).toBe(14);
  });

  it('allows the two faces to use different physical cap heights', () => {
    const zx81 = placeZx8xRows(ZX81_ROWS, 'zx81');
    const zx80 = placeZx8xRows(ZX80_ROWS, 'zx80');
    expect(zx81[0].cap.height).toBe(30);
    expect(zx80[0].cap.height).toBe(40);
    expect(zx8xScene('zx80').height).toBeGreaterThan(zx8xScene('zx81').height);
  });
});
