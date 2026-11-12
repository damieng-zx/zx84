/**
 * What the 8563 VDC shows: its registers and RAM drawn into an RGBA frame.
 *
 * The VDC builds the picture from character cells. Register 1 cells across,
 * register 6 rows down, each cell `(R22 >> 4) + 1` pixels wide and
 * `(R9 & 31) + 1` scan lines tall, of which `R22 & 15` pixels and `R23 & 31`
 * lines are shown. The screen RAM is at R12/R13 and, with the colour attributes
 * on (R25 bit 6), an attribute RAM at R20/R21 follows the same layout; each row
 * starts `R1 + R27` bytes after the last. A character's pixels are 16 bytes in
 * the character set at `(R28 & $E0) << 8`, or 4K further on for a cell whose
 * attribute selects the alternate set.
 *
 * Attribute byte: bit 7 alternate set, bit 6 reverse, bit 5 underline (at scan
 * line R29), bit 4 flash (alternating with reverse), bits 3-0 the foreground
 * colour (RGBI). The background, and the border, are R26's low nibble; with
 * the attributes off the foreground is its high nibble. R24 bit 6 reverses
 * everything and bit 5 chooses the flash rate (1/16 or 1/30 of the frame
 * rate); R10 bits 6-5 are the cursor mode (steady, none, 1/16, 1/32) over scan
 * lines R10 & 31 to R11 & 31, at the position in R14/R15. In bitmap mode
 * (R25 bit 7) the screen RAM is the picture itself, a byte to eight pixels.
 *
 * Not drawn: interlace, the display-enable window (R34/R35), the light pen.
 * The horizontal smooth scroll (R25 bits 3-0, which the editor leaves at 0)
 * moves the picture left by that many pixels, and the vertical (R24 bits 4-0)
 * up by that many lines; the directions are from the register descriptions,
 * not yet checked against a real chip.
 */

import { VDC_R, type Vdc } from './vdc.ts';

/** The frame the display is drawn into: 640×200 of picture and a border round it. */
export const VDC_FRAME_WIDTH = 704;
export const VDC_FRAME_HEIGHT = 248;
/** The width of a pixel relative to its height when the frame fills a 4:3 screen. */
export const VDC_PIXEL_ASPECT_X = (4 / 3) * VDC_FRAME_HEIGHT / VDC_FRAME_WIDTH;

/** The sixteen RGBI colours, as the frame's ABGR words: bit 3 red, 2 green, 1 blue, 0 intensity. */
export const VDC_PALETTE: Uint32Array = (() => {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const intensity = (i & 1) !== 0 ? 0x55 : 0;
    const r = ((i & 8) !== 0 ? 0xAA : 0) + intensity;
    const g = ((i & 4) !== 0 ? 0xAA : 0) + intensity;
    const b = ((i & 2) !== 0 ? 0xAA : 0) + intensity;
    out[i] = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  return out;
})();

/** Whether a flashing cell is in its reversed half now. */
function flashReversed(vdc: Vdc): boolean {
  const period = (vdc.regs[VDC_R.SCROLL_V] & 0x20) !== 0 ? 30 : 16;
  return vdc.frame % period >= period >> 1;
}

/** Whether the cursor is drawn this frame (R10 bits 6-5). */
function cursorShown(vdc: Vdc): boolean {
  switch ((vdc.regs[VDC_R.CURSOR_MODE] >> 5) & 3) {
    case 0: return true;
    case 1: return false;
    case 2: return vdc.frame % 16 < 8;
    default: return vdc.frame % 32 < 16;
  }
}

/**
 * Draw the VDC's picture into `out` (`VDC_FRAME_WIDTH` × `VDC_FRAME_HEIGHT`
 * words): the border colour, then the character area centred in it and clipped
 * to it.
 */
export function renderVdc(vdc: Vdc, out: Uint32Array): void {
  const r = vdc.regs;
  const ram = vdc.ram;
  const mask = ram.length - 1;
  const reverseScreen = (r[VDC_R.SCROLL_V] & 0x40) !== 0;
  const bgIndex = r[VDC_R.COLOUR] & 0x0F;
  out.fill(VDC_PALETTE[bgIndex]);

  const cols = r[VDC_R.HDISP];
  const rows = r[VDC_R.VDISP];
  const cellTotalW = (r[VDC_R.CHARH] >> 4) + 1;
  const cellW = Math.min(r[VDC_R.CHARH] & 0x0F, cellTotalW);
  const rowTotal = (r[VDC_R.CHARV] & 0x1F) + 1;
  const rowShown = Math.min(r[VDC_R.CHAR_DISP_V] & 0x1F, rowTotal);
  if (cols === 0 || rows === 0 || cellW === 0 || rowShown === 0) return;

  const mode = r[VDC_R.MODE];
  const bitmap = (mode & 0x80) !== 0;
  const colour = (mode & 0x40) !== 0;
  const semigraphic = (mode & 0x20) !== 0;
  const shiftLeft = mode & 0x0F;
  const vScroll = r[VDC_R.SCROLL_V] & 0x1F;

  const screen = (r[VDC_R.SCREEN_HI] << 8) | r[VDC_R.SCREEN_LO];
  const attrs = (r[VDC_R.ATTR_HI] << 8) | r[VDC_R.ATTR_LO];
  const stride = cols + r[VDC_R.ROW_ADD];
  const charBase = (r[VDC_R.CHARSET] & 0xE0) << 8;
  const underline = r[VDC_R.UNDERLINE] & 0x1F;
  const cursorAt = (r[VDC_R.CURSOR_HI] << 8) | r[VDC_R.CURSOR_LO];
  const cursorFrom = r[VDC_R.CURSOR_MODE] & 0x1F;
  const cursorTo = r[VDC_R.CURSOR_END] & 0x1F;
  const showCursor = cursorShown(vdc);
  const flashRev = flashReversed(vdc);
  const defaultFg = (r[VDC_R.COLOUR] >> 4) & 0x0F;

  const x0 = (VDC_FRAME_WIDTH - cols * cellTotalW) >> 1;
  const y0 = (VDC_FRAME_HEIGHT - rows * rowTotal) >> 1;
  const height = rows * rowTotal;

  for (let line = 0; line < height; line++) {
    const y = y0 + line;
    if (y < 0 || y >= VDC_FRAME_HEIGHT) continue;
    // The scan line of the display this line shows, after the vertical scroll.
    const src = line + vScroll;
    const row = Math.floor(src / rowTotal);
    const ln = src - row * rowTotal;
    if (ln >= rowShown || row > rows) continue;
    const rowBase = row * stride;
    const outRow = y * VDC_FRAME_WIDTH;
    for (let col = 0; col < cols; col++) {
      const cell = rowBase + col;
      const code = ram[(screen + cell) & mask];
      const attr = colour ? ram[(attrs + cell) & mask] : 0;
      let fg = colour ? attr & 0x0F : defaultFg;
      let bg = bgIndex;
      let glyph: number;
      if (bitmap) glyph = code;
      else glyph = ram[(charBase + ((attr & 0x80) !== 0 ? 0x1000 : 0) + code * 16 + ln) & mask];
      if ((attr & 0x20) !== 0 && ln === underline) glyph = 0xFF;
      if (showCursor && screen + cell === cursorAt && ln >= cursorFrom && ln <= cursorTo) glyph ^= 0xFF;
      let swap = reverseScreen !== ((attr & 0x40) !== 0);
      if ((attr & 0x10) !== 0 && flashRev) swap = !swap;
      if (swap) { const t = fg; fg = bg; bg = t; }
      const px0 = x0 + col * cellTotalW - shiftLeft;
      for (let p = 0; p < cellW; p++) {
        const x = px0 + p;
        if (x < 0 || x >= VDC_FRAME_WIDTH) continue;
        const on = p < 8 ? (glyph >> (7 - p)) & 1 : semigraphic ? glyph & 1 : 0;
        out[outRow + x] = VDC_PALETTE[on !== 0 ? fg : bg];
      }
    }
  }
}
