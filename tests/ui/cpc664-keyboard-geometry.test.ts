import { describe, expect, it } from 'vitest';
import {
  CPC664_SCENE,
  placeCpc664Keys,
} from '@/machines/cpc/ui/keyboard/scene-geometry.ts';
import {
  cpcKeyMain,
  isCpc664BlueKey,
} from '@/machines/cpc/ui/keyboard/variants.ts';

describe('CPC 664 keyboard scene geometry', () => {
  it('retains the complete 74-key CPC matrix', () => {
    const placed = placeCpc664Keys();
    expect(placed).toHaveLength(74);
    expect(placed.filter((item) => item.region === 'main')).toHaveLength(57);
    expect(placed.filter((item) => item.region === 'cursor')).toHaveLength(5);
    expect(placed.filter((item) => item.region === 'numpad')).toHaveLength(12);
  });

  it('keeps every cap inside the fixed scene', () => {
    for (const { key, box } of placeCpc664Keys()) {
      expect(box.x, `${key.id} left`).toBeGreaterThanOrEqual(0);
      expect(box.y, `${key.id} top`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${key.id} right`).toBeLessThanOrEqual(CPC664_SCENE.width);
      expect(box.y + box.height, `${key.id} bottom`).toBeLessThanOrEqual(CPC664_SCENE.height);
    }
  });

  it('spaces four clipped cursor wedges around COPY', () => {
    const cursors = placeCpc664Keys().filter((item) => item.region === 'cursor');
    const copy = cursors.find((item) => item.key.id === 'copy')!;
    const arrows = cursors.filter((item) => item.key.id !== 'copy');
    const byId = (id: string) => cursors.find((item) => item.key.id === id)!.box;

    expect(arrows.every((item) => item.hitClip?.startsWith('polygon('))).toBe(true);
    expect(arrows.filter((item) => item.box.width > item.box.height)).toHaveLength(2);
    expect(arrows.filter((item) => item.box.height > item.box.width)).toHaveLength(2);
    expect(copy.hitClip).toBeUndefined();
    expect(byId('cursor-up').y + byId('cursor-up').height).toBeLessThan(copy.box.y);
    expect(byId('cursor-down').y).toBeGreaterThan(copy.box.y + copy.box.height);
    expect(byId('cursor-left').x + byId('cursor-left').width).toBeLessThan(copy.box.x);
    expect(byId('cursor-right').x).toBeGreaterThan(copy.box.x + copy.box.width);
  });

  it('right-aligns DEL, RETURN and right SHIFT as one control column', () => {
    const placed = placeCpc664Keys();
    const byId = (id: string) => placed.find((item) => item.key.id === id)!.box;
    const rightEdge = (id: string) => byId(id).x + byId(id).width;

    expect(rightEdge('del')).toBe(rightEdge('shift-right'));
    expect(rightEdge('return')).toBe(rightEdge('shift-right'));
    expect(byId('return').x - rightEdge('backslash')).toBeGreaterThan(20);
  });

  it('uses the documented RETURN face and blue control set', () => {
    const byId = (id: string) =>
      placeCpc664Keys().find((item) => item.key.id === id)!.key;

    expect(cpcKeyMain(byId('return'), 'cpc664')).toBe('RETURN');
    expect(cpcKeyMain(byId('return'), 'cpc464')).toBe('ENTER');
    expect(isCpc664BlueKey(byId('return'))).toBe(true);
    expect(isCpc664BlueKey(byId('cursor-left'))).toBe(true);
    expect(isCpc664BlueKey(byId('numpad-enter'))).toBe(true);
    expect(isCpc664BlueKey(byId('copy'))).toBe(false);
    expect(isCpc664BlueKey(byId('clr'))).toBe(false);
  });
});
