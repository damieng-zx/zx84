/**
 * MsxScreenText — name-table OCR.
 *
 * In the MSX text modes the VDP name table holds character codes directly, so
 * OCR is a direct read. Expectations are built from crafted VRAM, independent of
 * the implementation: text mode = 40 cols from name base (regs[2]&0x0F)<<10.
 */
import { describe, it, expect } from 'vitest';
import { MsxScreenText, msxTextGrid } from '@/ocr/msx.ts';
import { TMS9918_PALETTE } from '@/cores/tms9918a.ts';

/** Text-mode registers: R1 bit4 = text mode; R7 = fg/bg; name base = 0. */
function textRegs(): Uint8Array {
  const r = new Uint8Array(8);
  r[1] = 0x10;   // M1 = text mode
  r[2] = 0x00;   // name table at 0x0000
  r[7] = 0xF4;   // fg = 15 (white), bg = 4 (dark blue)
  return r;
}

/** Write an ASCII string into the text-mode name table at (row, col). */
function writeText(vram: Uint8Array, base: number, row: number, col: number, s: string): void {
  for (let i = 0; i < s.length; i++) vram[base + row * 40 + col + i] = s.charCodeAt(i);
}

describe('MsxScreenText', () => {
  it('resolves the per-mode grid', () => {
    expect(msxTextGrid('text')).toEqual({ cols: 40, cellWidth: 6, xOffset: 8, grid: '40x24' });
    expect(msxTextGrid('graphics1')).toEqual({ cols: 32, cellWidth: 8, xOffset: 0, grid: '32x24' });
    expect(msxTextGrid('graphics2')).toBeNull();
    expect(msxTextGrid('multicolor')).toBeNull();
  });

  it('reads text-mode name-table codes as ASCII, trimming trailing blanks', () => {
    const vram = new Uint8Array(0x4000).fill(0x20);   // spaces
    writeText(vram, 0, 0, 0, 'HELLO');
    writeText(vram, 0, 2, 3, 'Ok');
    const text = new MsxScreenText().ocr(vram, textRegs(), 'text');
    // Row 0 = "HELLO" (trailing spaces trimmed); row 1 blank; row 2 = "   Ok".
    expect(text.split('\n')[0]).toBe('HELLO');
    expect(text.split('\n')[2]).toBe('   Ok');
    // No trailing blank rows.
    expect(text.endsWith('Ok')).toBe(true);
  });

  it('reports a note for bitmap (graphics2) modes', () => {
    const vram = new Uint8Array(0x4000);
    expect(new MsxScreenText().ocr(vram, textRegs(), 'graphics2')).toBe('(graphics mode — no text)');
  });

  it('produces a styled result with a match mask and paper indices', () => {
    const vram = new Uint8Array(0x4000).fill(0x20);
    writeText(vram, 0, 0, 0, 'AB');
    const res = new MsxScreenText().ocrStyled(vram, textRegs(), 'text', TMS9918_PALETTE);
    expect(res.grid).toBe('40x24');
    expect(res.cols).toBe(40);
    expect(res.rows).toBe(24);
    expect(res.cellWidth).toBe(6);
    // Cells 0,1 (A,B) matched; the rest are spaces → not matched.
    expect(res.mask[0]).toBe(true);
    expect(res.mask[1]).toBe(true);
    expect(res.mask[2]).toBe(false);
    // Text-mode paper = R7 low nibble (4).
    expect(res.paper![0]).toBe(4);
    // HTML carries the two glyphs.
    expect(res.html).toContain('A');
    expect(res.html).toContain('B');
  });
});
