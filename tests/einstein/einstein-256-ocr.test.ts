import { describe, it, expect } from 'vitest';
import { EinsteinV9938ScreenText } from '@/ocr/einstein256.ts';

/**
 * Synthetic V9938 GRAPHIC 2 screen: identity name table + a hand-built MOS-style
 * font, exercising the engine's addressing (name → code+third → pattern) without
 * the real ROM (unavailable in CI). End-to-end correctness against the actual
 * MOS 2.1 boot screen was verified separately by booting the real ROM headless.
 */

// A font where char C's 8-byte glyph lives at fontOffset + C*8. findFontOffset
// must resolve to 0, so: space (0x20) blank, the sampled letters (A B C E M 0 1)
// have 3–7 non-blank rows, and the sampled punctuation (. , :) have 1–4.
function buildFont(): { rom: Uint8Array; glyph: (c: string) => Uint8Array } {
  const rom = new Uint8Array(0x800);
  const put = (code: number, rows: number[]) => rom.set(rows, code * 8);
  const A = [0x00, 0x70, 0x48, 0x78, 0x48, 0x48, 0x00, 0x00]; // 5 rows
  const B = [0x00, 0x70, 0x48, 0x70, 0x48, 0x70, 0x00, 0x00]; // 5 rows, ≠ A
  const gen = [0x00, 0x78, 0x40, 0x40, 0x40, 0x78, 0x00, 0x00]; // 4 rows
  const dot = [0x00, 0x00, 0x00, 0x00, 0x00, 0x30, 0x00, 0x00]; // 1 row
  put(0x41, A); put(0x42, B);
  for (const c of [0x43, 0x45, 0x4d, 0x30, 0x31]) put(c, gen);
  for (const c of [0x2e, 0x2c, 0x3a]) put(c, dot);
  const glyph = (c: string): Uint8Array => rom.subarray(c.charCodeAt(0) * 8, c.charCodeAt(0) * 8 + 8);
  return { rom, glyph };
}

describe('Einstein 256 (V9938) OCR', () => {
  it('reads GRAPHIC 2 identity-name-table text via V9938 addressing', () => {
    const { rom, glyph } = buildFont();

    const regs = new Uint8Array(48);
    regs[2] = 0x06;  // name table @ 0x1800
    regs[4] = 0x00;  // pattern generator @ 0x0000
    regs[3] = 0x00;  // colour table @ 0x0000 (unused by plain-text OCR)
    regs[7] = 0xf0;  // fg 15 / bg 0

    const vram = new Uint8Array(0x30000);
    // Identity name table: cell (row,col) → code = row*32 + col.
    for (let i = 0; i < 32 * 24; i++) vram[0x1800 + i] = i & 0xFF;
    // Write 'A' into row 0 col 0 (code 0 → pattern @ 0) and 'B' into row 0 col 4
    // (byte-aligned: code 3 → pattern @ 24), spelling "A   B".
    vram.set(glyph('A'), 0);
    vram.set(glyph('B'), 3 * 8);

    const text = new EinsteinV9938ScreenText().ocr(vram, regs, 'graphic2', rom);
    const row0 = text.split('\n')[0];
    expect(row0[0]).toBe('A');
    expect(row0[4]).toBe('B');
    expect(row0.slice(1, 4)).toBe('   ');
  });

  it('reports no text outside GRAPHIC 2', () => {
    const { rom } = buildFont();
    const out = new EinsteinV9938ScreenText().ocr(new Uint8Array(0x30000), new Uint8Array(48), 'graphic4', rom);
    expect(out).toMatch(/no text/);
  });
});
