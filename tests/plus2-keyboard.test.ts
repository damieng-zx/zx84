/**
 * Grey ZX Spectrum +2 keyboard legend rules.
 *
 * Reference: photographs of the Amstrad grey +2 (1986). Unlike the 128K/+
 * "toastrack", its keycaps are almost bare — only the RUN/CODE/LOAD keywords
 * and the single-character symbol-shift tokens that have no dedicated key
 * survive. The expected kept-red set below is derived from the hardware (the
 * standard Spectrum symbol-shift legend for each letter), NOT from the
 * implementation, so the test pins the real machine.
 */

import { describe, it, expect } from 'vitest';
import { plus2KeepsRed, sparseKeyboardFace, plus2KeyWidth, PLUS2_KEYWORDS } from '@/components/panes/plus2-legends.ts';

// The standard symbol-shift token printed in red on each letter key (ZX Spectrum
// manual). Independently transcribed here; '−' is U+2212 and '↑' is U+2191 as on
// the real keyboard.
const LETTER_RED: Record<string, string> = {
  Q: '<=', W: '<>', E: '>=', R: '<', T: '>',
  Y: 'AND', U: 'OR', I: 'AT', O: ';', P: '"',
  A: 'STOP', S: 'NOT', D: 'STEP', F: 'TO', G: 'THEN',
  H: '↑', J: '−', K: '+', L: '=',
  Z: ':', X: '£', C: '?', V: '/', B: '*', N: ',', M: '.',
};

describe('plus2KeepsRed — which red symbol-shift tokens the grey +2 prints', () => {
  it('keeps exactly the single-char operators that have no dedicated key', () => {
    const kept = Object.keys(LETTER_RED).filter((g) => plus2KeepsRed(LETTER_RED[g])).sort();
    expect(kept).toEqual(['B', 'C', 'H', 'J', 'K', 'L', 'R', 'T', 'V', 'X', 'Z']);
  });

  it('drops multi-character tokens (compound operators and BASIC words)', () => {
    expect(plus2KeepsRed('<=')).toBe(false);
    expect(plus2KeepsRed('AND')).toBe(false);
    expect(plus2KeepsRed('STOP')).toBe(false);
  });

  it('drops symbols that have their own dedicated key', () => {
    for (const s of [';', '"', ',', '.']) expect(plus2KeepsRed(s)).toBe(false);
  });

  it('keeps awkward single glyphs (↑, −, £) — still one character each', () => {
    expect(plus2KeepsRed('↑')).toBe(true);
    expect(plus2KeepsRed('−')).toBe(true);
    expect(plus2KeepsRed('£')).toBe(true);
  });

  it('treats empty/undefined as not kept', () => {
    expect(plus2KeepsRed(undefined)).toBe(false);
    expect(plus2KeepsRed('')).toBe(false);
  });
});

describe('PLUS2_KEYWORDS — the only BASIC keywords left on the caps', () => {
  it('is exactly RUN on R, CODE on I, LOAD on J', () => {
    expect(PLUS2_KEYWORDS).toEqual({ R: 'RUN', I: 'CODE', J: 'LOAD' });
  });
});

describe('sparseKeyboardFace — which sparse face a model uses', () => {
  it('grey for the +2', () => {
    expect(sparseKeyboardFace('+2')).toBe('grey2');
  });

  it('near-black (amstrad) for the +2A and +3', () => {
    expect(sparseKeyboardFace('+2A')).toBe('amstrad');
    expect(sparseKeyboardFace('+3')).toBe('amstrad');
  });

  it('no sparse face for the 128K (it keeps the full toastrack legends)', () => {
    expect(sparseKeyboardFace('128k')).toBe(null);
  });

  it('no sparse face for 48K (handled by the rubber keyboard, not this path)', () => {
    expect(sparseKeyboardFace('48k')).toBe(null);
  });
});

describe('plus2KeyWidth — a fixed quarter-unit grid where every row totals 13.5u', () => {
  it('shrinks TRUE/INV VIDEO, GRAPH, EDIT, CAPS LOCK and SYMBOL SHIFT to 1u', () => {
    expect(plus2KeyWidth('fn', 'TRUE\nVIDEO', 1.5)).toBe(1);
    expect(plus2KeyWidth('fn', 'INV\nVIDEO', 1.5)).toBe(1);
    expect(plus2KeyWidth('fn', 'GRAPH', 1.4)).toBe(1);
    expect(plus2KeyWidth('fn', 'EDIT', 1.4)).toBe(1);
    expect(plus2KeyWidth('fn', 'CAPS\nLOCK', 1.4)).toBe(1);
    expect(plus2KeyWidth('mod', 'SYMBOL\nSHIFT', 1.6)).toBe(1);
    expect(plus2KeyWidth('enter', undefined, 1.3)).toBe(1);
  });

  it('sizes the wider keys on quarter units', () => {
    expect(plus2KeyWidth('fn', 'DELETE', 1.7)).toBe(1.5);
    expect(plus2KeyWidth('fn', 'BREAK', 1.5)).toBe(1.5);
    expect(plus2KeyWidth('fn', 'EXTEND\nMODE', 1.7)).toBe(1.75);
    expect(plus2KeyWidth('mod', 'CAPS\nSHIFT', 2)).toBe(2.25);
    expect(plus2KeyWidth('enter-spacer', undefined, 2.6)).toBe(1.75);
    expect(plus2KeyWidth('space', undefined, 6)).toBe(4.5);
  });

  it('leaves alphanumerics and the dedicated symbol/arrow keys at 1u', () => {
    expect(plus2KeyWidth('letter', undefined, 1)).toBe(1);
    expect(plus2KeyWidth('num', undefined, 1)).toBe(1);
    expect(plus2KeyWidth('sym', undefined, 1)).toBe(1);
    expect(plus2KeyWidth('arrow', undefined, 1)).toBe(1);
  });

  it('every width is a whole or quarter unit', () => {
    const ws = [
      plus2KeyWidth('fn', 'DELETE', 1), plus2KeyWidth('fn', 'BREAK', 1),
      plus2KeyWidth('fn', 'EXTEND\nMODE', 1), plus2KeyWidth('mod', 'CAPS\nSHIFT', 1),
      plus2KeyWidth('enter', undefined, 1), plus2KeyWidth('enter-spacer', undefined, 1),
      plus2KeyWidth('space', undefined, 1),
    ];
    for (const w of ws) expect((w * 4) % 1).toBe(0);
  });

  it('every row totals the same 13.5u (so rows share both edges)', () => {
    const w = plus2KeyWidth;
    const row1 = w('fn', 'TRUE\nVIDEO', 1) + w('fn', 'INV\nVIDEO', 1) + 10 * 1 + w('fn', 'BREAK', 1);
    const row2 = w('fn', 'DELETE', 1) + w('fn', 'GRAPH', 1) + 10 * 1 + w('enter', undefined, 1);
    const row3 = w('fn', 'EXTEND\nMODE', 1) + w('fn', 'EDIT', 1) + 9 * 1 + w('enter-spacer', undefined, 1);
    const row4 = w('mod', 'CAPS\nSHIFT', 1) + w('fn', 'CAPS\nLOCK', 1) + 7 * 1 + 1 + w('mod', 'CAPS\nSHIFT', 1);
    const row5 = w('mod', 'SYMBOL\nSHIFT', 1) + 4 * 1 + w('space', undefined, 1) + 3 * 1 + w('mod', 'SYMBOL\nSHIFT', 1);
    expect(row1).toBeCloseTo(13.5, 5);
    expect(row2).toBeCloseTo(13.5, 5);
    expect(row3).toBeCloseTo(13.5, 5);
    expect(row4).toBeCloseTo(13.5, 5);
    expect(row5).toBeCloseTo(13.5, 5);
  });
});
