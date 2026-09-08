import { describe, expect, it } from 'vitest';
import {
  CPC664_SCENE,
  placeCpc664Keys,
} from '@/machines/cpc/ui/keyboard/scene-geometry.ts';
import {
  cpcKeyMain,
  cpcKeyShift,
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

  it('right-aligns DEL, ENTER and right SHIFT as one control column', () => {
    const placed = placeCpc664Keys();
    const byId = (id: string) => placed.find((item) => item.key.id === id)!.box;
    const rightEdge = (id: string) => byId(id).x + byId(id).width;

    expect(rightEdge('del')).toBe(rightEdge('shift-right'));
    expect(rightEdge('return')).toBe(rightEdge('shift-right'));
    expect(byId('del').x - rightEdge('clr')).toBe(4);
  });

  it('shapes ENTER as an inverted L beside the bracket caps', () => {
    const placed = placeCpc664Keys();
    const byId = (id: string) => placed.find((item) => item.key.id === id)!;
    const rightEdge = (id: string) => byId(id).box.x + byId(id).box.width;
    const enter = byId('return');

    expect(enter.box.x).toBe(rightEdge('open-bracket') + 4);
    const notch = Number(
      /100% 100%, ([\d.]+)%/.exec(enter.hitClip ?? '')![1]);
    const lowerArmLeft = enter.box.x + (notch / 100) * enter.box.width;
    expect(lowerArmLeft).toBeCloseTo(rightEdge('close-bracket') + 4, 0);
  });

  it('spans the space bar from X to slash with a single-unit CTRL', () => {
    const placed = placeCpc664Keys();
    const byId = (id: string) => placed.find((item) => item.key.id === id)!.box;
    const rightEdge = (id: string) => byId(id).x + byId(id).width;

    expect(byId('space').x).toBe(byId('x').x);
    expect(rightEdge('space')).toBe(rightEdge('slash'));
    expect(byId('ctrl').width).toBe(byId('z').width);
    expect(byId('ctrl').x).toBeGreaterThan(rightEdge('space'));
  });

  it('lines the space row up with the f0/f./ENTER keypad row', () => {
    const placed = placeCpc664Keys();
    const byId = (id: string) => placed.find((item) => item.key.id === id)!.box;

    for (const id of ['f0', 'fdot', 'numpad-enter']) {
      expect(byId(id).y, `${id} baseline`).toBe(byId('space').y);
    }
  });

  it('prints the keypad as f-legends and drops the backslash grave', () => {
    const placed = placeCpc664Keys();
    const byId = (id: string) => placed.find((item) => item.key.id === id)!.key;

    expect(cpcKeyMain(byId('f0'), 'cpc664')).toBe('f0');
    expect(cpcKeyMain(byId('fdot'), 'cpc664')).toBe('.');
    expect(cpcKeyShift(byId('backslash'), 'cpc664')).toBeUndefined();
    expect(cpcKeyShift(byId('backslash'), 'cpc464')).toBe('`');
    expect(cpcKeyShift(byId('dot'), 'cpc664')).toBe('<');
  });

  it('uses the documented ENTER face and blue control set', () => {
    const byId = (id: string) =>
      placeCpc664Keys().find((item) => item.key.id === id)!.key;

    expect(cpcKeyMain(byId('return'), 'cpc664')).toBe('ENTER');
    expect(cpcKeyMain(byId('return'), 'cpc6128')).toBe('RETURN');
    expect(isCpc664BlueKey(byId('return'))).toBe(true);
    expect(isCpc664BlueKey(byId('cursor-left'))).toBe(true);
    expect(isCpc664BlueKey(byId('numpad-enter'))).toBe(true);
    expect(isCpc664BlueKey(byId('copy'))).toBe(false);
    expect(isCpc664BlueKey(byId('clr'))).toBe(false);
  });
});
