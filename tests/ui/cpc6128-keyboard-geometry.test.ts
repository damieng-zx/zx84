import { describe, expect, it } from 'vitest';
import {
  CPC6128_SCENE,
  placeCpc6128Keys,
} from '@/machines/cpc/ui/keyboard/scene-geometry.ts';
import { cpcKeyMain } from '@/machines/cpc/ui/keyboard/variants.ts';

describe('CPC 6128 keyboard scene geometry', () => {
  it('rearranges the complete 74-key CPC matrix', () => {
    const placed = placeCpc6128Keys();
    expect(placed).toHaveLength(74);
    expect(new Set(placed.map((item) => item.key.id)).size).toBe(74);
  });

  it('keeps every cap inside the compact fixed scene', () => {
    for (const { key, box } of placeCpc6128Keys()) {
      expect(box.x, `${key.id} left`).toBeGreaterThanOrEqual(0);
      expect(box.y, `${key.id} top`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${key.id} right`).toBeLessThanOrEqual(CPC6128_SCENE.width);
      expect(box.y + box.height, `${key.id} bottom`).toBeLessThanOrEqual(CPC6128_SCENE.height);
    }
  });

  it('uses the photographed five-row function and cursor block', () => {
    const placed = placeCpc6128Keys();
    const byId = (id: string) => placed.find((item) => item.key.id === id)!.box;

    expect(byId('f7').y).toBeLessThan(byId('f4').y);
    expect(byId('f4').y).toBeLessThan(byId('f1').y);
    expect(byId('f1').y).toBeLessThan(byId('f0').y);
    expect(byId('cursor-up').y).toBeLessThan(byId('cursor-down').y);
    expect(byId('cursor-left').y).toBe(byId('cursor-down').y);
    expect(byId('cursor-right').y).toBe(byId('cursor-down').y);
  });

  it('places CONTROL, COPY, SPACE and wide ENTER across the bottom row', () => {
    const placed = placeCpc6128Keys();
    const byId = (id: string) => placed.find((item) => item.key.id === id)!.box;

    expect(byId('ctrl').x).toBeLessThan(byId('copy').x);
    expect(byId('copy').x).toBeLessThan(byId('space').x);
    expect(byId('space').x).toBeLessThan(byId('numpad-enter').x);
    expect(byId('numpad-enter').width).toBeGreaterThan(byId('ctrl').width);
  });

  it('uses the 6128 RETURN, CONTROL and function-key faces', () => {
    const placed = placeCpc6128Keys();
    const key = (id: string) => placed.find((item) => item.key.id === id)!.key;

    expect(cpcKeyMain(key('return'), 'cpc6128')).toBe('RETURN');
    expect(cpcKeyMain(key('ctrl'), 'cpc6128')).toBe('CONTROL');
    expect(cpcKeyMain(key('f7'), 'cpc6128')).toBe('f7');
    expect(cpcKeyMain(key('f7'), 'cpc664')).toBe('7');
  });

  it('widens CAPS LOCK to stagger the A row without crowding RETURN', () => {
    const placed = placeCpc6128Keys();
    const box = (id: string) =>
      placed.find((item) => item.key.id === id)!.box;
    const rightEdge = (id: string) => box(id).x + box(id).width;

    expect(box('caps-lock').width).toBeGreaterThan(box('tab').width);
    expect(box('a').x).toBeGreaterThan(box('q').x);
    const returnStemLeft = box('return').x + box('return').width * 0.1515;
    expect(rightEdge('close-bracket')).toBeLessThan(returnStemLeft);
    expect(returnStemLeft - rightEdge('close-bracket')).toBeCloseTo(4, 1);
  });

  it('uses a seven-shaped RETURN and aligns the main right edge', () => {
    const placed = placeCpc6128Keys();
    const item = (id: string) =>
      placed.find((placedKey) => placedKey.key.id === id)!;
    const rightEdge = (id: string) =>
      item(id).box.x + item(id).box.width;

    expect(item('return').hitClip).toContain('polygon');
    expect(rightEdge('del')).toBe(rightEdge('return'));
    expect(rightEdge('shift-right')).toBe(rightEdge('return'));
    expect(rightEdge('numpad-enter')).toBe(rightEdge('return'));
  });

  it('continues into the function block with the normal key gap', () => {
    const placed = placeCpc6128Keys();
    const box = (id: string) =>
      placed.find((item) => item.key.id === id)!.box;
    const gap = (leftId: string, rightId: string) =>
      box(rightId).x - (box(leftId).x + box(leftId).width);

    expect(gap('del', 'f7')).toBe(gap('f7', 'f8'));
    expect(gap('return', 'f4')).toBe(gap('f4', 'f5'));
    expect(gap('numpad-enter', 'cursor-left')).toBe(
      gap('cursor-left', 'cursor-down'),
    );
  });

  it('makes COPY narrower than CONTROL', () => {
    const placed = placeCpc6128Keys();
    const box = (id: string) =>
      placed.find((item) => item.key.id === id)!.box;

    expect(box('copy').width).toBeLessThan(box('ctrl').width);
  });
});
