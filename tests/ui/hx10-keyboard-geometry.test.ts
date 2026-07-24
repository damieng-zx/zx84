import { describe, expect, it } from 'vitest';
import {
  HX10_SCENE,
  placeHx10Keys,
} from '@/machines/msx/ui/keyboard/scene-geometry.ts';

describe('Toshiba HX-10 keyboard scene geometry', () => {
  it('places the complete 73-cap UK keyboard', () => {
    const placed = placeHx10Keys();

    expect(placed).toHaveLength(73);
    expect(new Set(placed.map(({ key }) => key.id)).size).toBe(73);
  });

  it('covers every international MSX matrix cell in rows 0 through 8', () => {
    const placed = placeHx10Keys();
    const cells = placed.map(({ key }) => key.cell.join(','));
    const uniqueCells = new Set(cells);

    expect(uniqueCells.size).toBe(72);
    for (let row = 0; row <= 8; row++) {
      for (let bit = 0; bit < 8; bit++) {
        expect(uniqueCells.has(`${row},${bit}`), `matrix ${row},${bit}`).toBe(true);
      }
    }
    expect(cells.filter((cell) => cell === '6,0')).toHaveLength(2);
  });

  it('keeps every cap inside the fixed scene', () => {
    for (const { key, box } of placeHx10Keys()) {
      expect(box.x, `${key.id} left`).toBeGreaterThanOrEqual(0);
      expect(box.y, `${key.id} top`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${key.id} right`).toBeLessThanOrEqual(HX10_SCENE.width);
      expect(box.y + box.height, `${key.id} bottom`).toBeLessThanOrEqual(HX10_SCENE.height);
    }
  });

  it('uses the photographed dual-function and coloured control caps', () => {
    const placed = placeHx10Keys();
    const key = (id: string) =>
      placed.find((item) => item.key.id === id)!.key;

    expect(key('f1').aux).toBe('F6');
    expect(key('f5').aux).toBe('F10');
    expect(key('stop').tone).toBe('red');
    expect(key('graph').tone).toBe('green');
    expect(key('cursor-up').tone).toBe('blue');
    expect(key('pound').main).toBe('£');
  });

  it('uses a two-row inverted-L RETURN beside the staggered main rows', () => {
    const placed = placeHx10Keys();
    const item = (id: string) =>
      placed.find((placedKey) => placedKey.key.id === id)!;

    expect(item('return').box.height).toBeGreaterThan(item('close-bracket').box.height);
    expect(item('return').hitClip).toContain('polygon');
    expect(item('backquote').box.x + item('backquote').box.width)
      .toBeLessThan(item('return').box.x + item('return').box.width);
  });

  it('forms the detached edit block and cursor cross', () => {
    const placed = placeHx10Keys();
    const box = (id: string) =>
      placed.find((item) => item.key.id === id)!.box;

    expect(box('ins').y).toBe(box('del').y);
    expect(box('select').y).toBe(box('home').y);
    expect(box('select').y).toBeGreaterThan(box('ins').y);

    expect(box('cursor-up').x).toBe(box('cursor-down').x);
    expect(box('cursor-left').y).toBe(box('cursor-right').y);
    expect(box('cursor-left').x).toBeLessThan(box('cursor-up').x);
    expect(box('cursor-right').x).toBeGreaterThan(box('cursor-up').x);
  });
});
