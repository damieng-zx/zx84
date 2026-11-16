/**
 * Commodore 128 80-column (VDC) screen-text OCR.
 *
 * As on the VIC-IIe screen, the 8563 keeps character *codes* in its screen
 * RAM, so text is read from the matrix and the glyph each code shows is
 * checked against a font: a character of the font reads as itself and its
 * inverse as that character in reverse video; anything else (a program's own
 * tiles, a bitmap mode) is left alone.
 *
 * The font is not a chip ROM: the KERNAL copies one into VDC RAM at boot, at
 * `(R28 & $E0) << 8`, two 4K sets of 256 glyphs of 16 bytes. The first set is
 * the upper-case one and the second, 4K further on, the lower-case one, which
 * a cell selects with its attribute's bit 7 — the same two-set arrangement the
 * VIC-IIe's character ROM has, so the shared glyph matcher serves here too.
 *
 * The grid is the registers': `R1` cells across, `R6` rows down, each row
 * starting `R1 + R27` bytes after the last. A cell is `(R22 >> 4) + 1` pixels
 * wide by `(R9 & 31) + 1` lines tall, of which `R22 & 15` pixels and
 * `R23 & 31` lines are shown, so the overlay must not assume 8×8.
 *
 * Attribute byte (with `R25` bit 6): bit 7 alternate set, bit 6 reverse, bit 5
 * underline, bit 4 flash, bits 3-0 foreground. The background is `R26`'s low
 * nibble; with the attributes off the foreground is its high nibble. A cell
 * the chip reverses — by `R24` bit 6 or its own bit 6 — is read with its
 * colours swapped, exactly as it looks.
 *
 * The font in VDC RAM is not always in the KERNAL's order: CP/M loads its own,
 * whose lower-case set is laid out by ASCII code, so reading a glyph as the
 * character its code means in the KERNAL's order turns CP/M's lower case into
 * graphics. A glyph is therefore matched by its shape against the character
 * ROM's own 128-mode set when the caller has one (`reference`), whatever code
 * it sits at, and only after that against the RAM font read in the KERNAL's order.
 *
 * Self-contained by design: it takes the VDC (and the ROM's glyphs), never the machine.
 */

import type { OcrGridName } from '@/ocr/ocr.ts';
import { cbmGridText, cbmMatchGlyph, cbmRomGlyphs, type C64OcrResult } from '@/ocr/c64.ts';
import { VDC_PALETTE } from './vdc-display.ts';
import { VDC_R, type Vdc } from './vdc.ts';

/**
 * The two character sets as `cbmRomGlyphs` wants them: set `s`, code `c` at
 * `s * $800 + c * 8`, codes 0-127 only (the chip's 128-255 are the inverse
 * glyphs of those, which the matcher derives itself). Each VDC glyph is 16
 * bytes with the 8 drawn lines first.
 */
function vdcFont(vdc: Vdc, base: number): Uint8Array {
  const out = new Uint8Array(0x1000);
  for (let set = 0; set < 2; set++) {
    for (let code = 0; code < 128; code++) {
      const at = base + set * 0x1000 + code * 16;
      for (let line = 0; line < 8; line++) out[set * 0x800 + code * 8 + line] = vdc.at(at + line);
    }
  }
  return out;
}

export function vdcOcrGrid(vdc: Vdc, reference: Uint8Array | null = null): C64OcrResult {
  const r = vdc.regs;
  const cols = Math.max(r[VDC_R.HDISP], 1);
  const rows = Math.max(r[VDC_R.VDISP], 1);
  const n = cols * rows;
  const bg = r[VDC_R.COLOUR] & 0x0F;
  const cells: string[] = new Array(n).fill(' ');
  const ink: number[] = new Array(n).fill(0);
  const paper: number[] = new Array(n).fill(bg);
  const hit: boolean[] = new Array(n).fill(false);

  const bitmap = (r[VDC_R.MODE] & 0x80) !== 0;
  if (!bitmap && r[VDC_R.HDISP] > 0 && r[VDC_R.VDISP] > 0) {
    const screen = (r[VDC_R.SCREEN_HI] << 8) | r[VDC_R.SCREEN_LO];
    const attrs = (r[VDC_R.ATTR_HI] << 8) | r[VDC_R.ATTR_LO];
    const stride = r[VDC_R.HDISP] + r[VDC_R.ROW_ADD];
    const charBase = (r[VDC_R.CHARSET] & 0xE0) << 8;
    const colourOn = (r[VDC_R.MODE] & 0x40) !== 0;
    const reverseScreen = (r[VDC_R.SCROLL_V] & 0x40) !== 0;
    const defaultFg = (r[VDC_R.COLOUR] >> 4) & 0x0F;

    const rom = new Map(reference ? cbmRomGlyphs(reference) : []);
    for (const [shape, ch] of cbmRomGlyphs(vdcFont(vdc, charBase))) if (!rom.has(shape)) rom.set(shape, ch);
    const seen = new Map<number, { ch: string; reversed: boolean }>();
    const read = (addr: number) => cbmMatchGlyph(rom, a => vdc.at(a), addr, seen);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        const cell = row * stride + col;
        const code = vdc.at(screen + cell);
        const attr = colourOn ? vdc.at(attrs + cell) : 0;
        const alt = (attr & 0x80) !== 0;
        const { ch, reversed } = read((charBase + (alt ? 0x1000 : 0) + code * 16) & 0xFFFF);
        if (ch === ' ') continue;
        const fg = colourOn ? attr & 0x0F : defaultFg;
        // Drawn with the colours swapped by the chip's reverse bit or by the
        // code being an inverse glyph.
        const swapped = (reverseScreen !== ((attr & 0x40) !== 0)) !== reversed;
        cells[i] = ch;
        hit[i] = true;
        ink[i] = swapped ? bg : fg;
        paper[i] = swapped ? fg : bg;
      }
    }
  }

  const { text, html } = cbmGridText(cells, ink, cols, rows, VDC_PALETTE);
  const grid = `${cols}x${rows}` as OcrGridName;
  return {
    text, html, mask: hit, paper, grid,
    cellWidth: (r[VDC_R.CHARH] >> 4) + 1, cellHeight: (r[VDC_R.CHARV] & 0x1F) + 1,
    cols, rows,
  };
}
