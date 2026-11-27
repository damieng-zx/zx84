/**
 * The VIC-20's TEXT overlay: the VIC's text area read as text by matching
 * each code's glyph against the character ROM (a ROM glyph reads as its
 * character, its inverse as the character reversed), placed where the VIC's
 * origins put it.
 */

import { describe, it, expect } from 'vitest';
import { VIC20_PAL_TIMING } from '@/machines/vic20/constants.ts';
import { firmware, machine } from './firmware.ts';

/** Glyphs for screen codes 1 (A) and 2 (B), and code 1's inverse at $400 + 8,
 *  as the real ROM has its reversed set at $400. */
const A = [0x18, 0x24, 0x42, 0x7E, 0x42, 0x42, 0x42, 0x00];
const B = [0x7C, 0x42, 0x42, 0x7C, 0x42, 0x42, 0x7C, 0x00];

function vic20WithText() {
  const m = machine(firmware());
  for (let f = 0; f < 2; f++) m.tick();                // the firmware sets the VIC up
  const cg = m.memory.chargen;
  cg.fill(0);
  cg.set(A, 1 * 8);
  cg.set(B, 2 * 8);
  cg.set(A.map(b => ~b & 0xFF), 0x400 + 1 * 8);
  m.memory.ram.fill(0x20, 0x1E00, 0x2000);             // code $20: blank here
  return m;
}

describe('VIC-20 TEXT overlay', () => {
  it('reads codes whose glyphs are ROM characters, in their colours', () => {
    const m = vic20WithText();
    m.memory.ram.set([1, 2, 1], 0x1E00);
    m.memory.colorRam.set([2, 6, 0], 0x200);
    const r = m.ocrScreenStyled();
    expect(r.cols).toBe(22);
    expect(r.rows).toBe(23);
    expect(r.text.split('\n')[0].trimEnd()).toBe('ABA');
    expect(r.mask.slice(0, 4)).toEqual([true, true, true, false]);
    expect(r.html).toContain('<span');
    m.destroy();
  });

  it('reads a reversed glyph as its character, its colours swapped', () => {
    const m = vic20WithText();
    m.memory.ram[0x1E00] = 0x81;                         // code 1 + reverse: the inverse glyph
    m.memory.colorRam[0x200] = 2;
    const r = m.ocrScreenStyled();
    expect(r.text[0]).toBe('A');
    // White background (the firmware's $1B): the cell shows red on white
    // reversed, so its paper is the character colour.
    expect(r.paper[0]).toBe(2);
    m.destroy();
  });

  it('leaves multicolour cells alone', () => {
    const m = vic20WithText();
    m.memory.ram[0x1E00] = 1;
    m.memory.colorRam[0x200] = 0x0A;                     // bit 3: multicolour
    expect(m.ocrScreenStyled().mask[0]).toBe(false);
    m.destroy();
  });

  it('puts the field where the VIC\'s origins put the text', () => {
    const m = vic20WithText();
    const t = VIC20_PAL_TIMING;
    expect(m.textField).toEqual({
      x: (12 * 4 - t.firstPixel) * 2, y: 38 * 2 - t.firstLine, width: 22 * 16, height: 23 * 8,
    });
    m.destroy();
  });
});
