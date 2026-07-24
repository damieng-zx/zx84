import { describe, expect, it } from 'vitest';
import {
  alignKeys,
  cloneDocument,
  distributeKeys,
  documentAsJson,
  documentAsTypeScript,
  keysIntersectingBox,
  parseKeyboardLabDocument,
  shapeClip,
  snapValue,
} from '@/ui/keyboard-lab/operations.ts';
import type { KeyboardLabDocument } from '@/ui/keyboard-lab/types.ts';

const document: KeyboardLabDocument = {
  version: 1,
  id: 'test-board',
  name: 'Test board',
  theme: 'cream',
  scene: { width: 300, height: 120 },
  reference: {
    name: 'photo.jpg',
    x: 1,
    y: 2,
    width: 200,
    height: 100,
    rotation: 0,
    opacity: 0.5,
  },
  keys: [
    { id: 'a', box: { x: 10, y: 10, width: 20, height: 20 }, legends: { main: 'A' } },
    { id: 'b', box: { x: 50, y: 20, width: 30, height: 10 }, legends: { main: 'B' } },
    { id: 'c', box: { x: 110, y: 30, width: 20, height: 20 }, legends: { main: 'C' } },
  ],
};

describe('keyboard lab operations', () => {
  it('snaps to the nearest positive grid interval', () => {
    expect(snapValue(12.4, 4)).toBe(12);
    expect(snapValue(14.1, 4)).toBe(16);
    expect(snapValue(-2.1, 4)).toBe(-4);
  });

  it('aligns selected keys without changing unselected keys', () => {
    const result = alignKeys(document.keys, new Set(['a', 'b']), 'right');

    expect(result.map((key) => key.box.x)).toEqual([60, 50, 110]);
    expect(result[2]).toBe(document.keys[2]);
  });

  it('distributes mixed-width keys with equal edge gaps', () => {
    const result = distributeKeys(document.keys, new Set(['a', 'b', 'c']), 'horizontal');

    expect(result.map((key) => key.box.x)).toEqual([10, 55, 110]);
  });

  it('finds every key touched by a rubber-band selection', () => {
    expect(keysIntersectingBox(
      document.keys,
      { x: 25, y: 15, width: 90, height: 20 },
    )).toEqual(['a', 'b', 'c']);
    expect(keysIntersectingBox(
      document.keys,
      { x: 30, y: 10, width: 20, height: 10 },
    )).toEqual([]);
  });

  it('deeply clones editable nested values', () => {
    const cloned = cloneDocument(document);

    expect(cloned).toEqual(document);
    expect(cloned).not.toBe(document);
    expect(cloned.scene).not.toBe(document.scene);
    expect(cloned.reference).not.toBe(document.reference);
    expect(cloned.keys[0].box).not.toBe(document.keys[0].box);
    expect(cloned.keys[0].legends).not.toBe(document.keys[0].legends);
  });

  it('round-trips the JSON export including reference registration', () => {
    const parsed = parseKeyboardLabDocument(JSON.parse(documentAsJson(document)));

    expect(parsed).toEqual(document);
  });

  it('rejects duplicate ids and unknown shape presets', () => {
    const duplicate = {
      ...document,
      keys: [document.keys[0], { ...document.keys[1], id: 'a' }],
    };
    const unknownShape = {
      ...document,
      keys: [{ ...document.keys[0], shape: 'star' }],
    };

    expect(() => parseKeyboardLabDocument(duplicate)).toThrow('Duplicate key id: a');
    expect(() => parseKeyboardLabDocument(unknownShape)).toThrow('unknown shape');
  });

  it('exports directly usable TypeScript constants', () => {
    const source = documentAsTypeScript(document);

    expect(source).toContain('export const testBoardScene = {"width":300,"height":120} as const;');
    expect(source).toContain('id: "a"');
    expect(source).toContain('legends: {"main":"A"}');
  });

  it('provides clips for the non-rectangular key presets', () => {
    expect(shapeClip('rectangle')).toBeUndefined();
    expect(shapeClip('return')).toMatch(/^polygon/);
    expect(shapeClip('wedge-left')).toMatch(/^polygon/);
  });

  it('materialises a shape clip in both export formats', () => {
    const shaped = {
      ...document,
      keys: [{ ...document.keys[0], shape: 'return' as const }],
    };

    expect(JSON.parse(documentAsJson(shaped)).keys[0].clipPath).toMatch(/^polygon/);
    expect(documentAsTypeScript(shaped)).toContain('clipPath: "polygon(');
  });
});
