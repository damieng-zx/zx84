/**
 * The Oric ULA (`HCS10017`): video generation, screen addressing, and the
 * serial-attribute register file.
 *
 * The ULA reads 40 bytes from memory for every one of the 224 displayed lines
 * and turns them into 240 pixels. Two modes are available per line, chosen by
 * a *serial attribute* — a byte with bits 5 and 6 both clear — encountered
 * in-line as the ULA reads:
 *
 *   X0000xxx  ink (foreground) colour
 *   X0001xxx  style: alternate charset, double height, blink
 *   X0010xxx  paper (background) colour
 *   X0011xxx  mode: hires, 50/60 Hz
 *
 * The ink, style and paper registers reset at the start of every line (white
 * on black, standard charset, no blink, single height); the mode register
 * persists across lines and frames. An attribute draws six pixels in the paper
 * colour — its own cell — so a paper change visibly affects the cell the
 * attribute sits in. Attributes take effect immediately, on the cell they are
 * read from.
 *
 * Text: the 40 bytes are ASCII, and each is looked up in the character set
 * copied into RAM at $B400 (standard) or $B800 (alternate). Hires: the bytes
 * are bitmaps, six pixels each, from $A000.
 *
 * Past line 200 the ULA stops honouring hires and carries on with text
 * addressing, which is how a screen mixes a hires picture with text rows below
 * it. Text rows 25-27 live at $BF68 onward, inside the hires area.
 */

import type { OricMemory } from './oric-memory.ts';
import {
  ORIC_ACTIVE_HEIGHT, ORIC_ACTIVE_WIDTH, ORIC_BORDER_LEFT, ORIC_BORDER_TOP,
  ORIC_CELL_HEIGHT, ORIC_CELL_WIDTH,
  ORIC_CHARSET_TEXT, ORIC_CHARSET_TEXT_ALT, ORIC_HIRES_LAST_LINE, ORIC_HIRES_SCREEN,
  ORIC_PALETTE, ORIC_RESET_INK, ORIC_RESET_PAPER, ORIC_SCREEN_HEIGHT,
  ORIC_SCREEN_WIDTH, ORIC_TEXT_COLS, ORIC_TEXT_SCREEN,
} from './constants.ts';

/** Style register bits. */
export const STYLE_ALT_CHARSET = 0x01;
export const STYLE_DOUBLE_HEIGHT = 0x02;
export const STYLE_BLINK = 0x04;
/** Mode register bits. */
export const MODE_60HZ = 0x02;
export const MODE_HIRES = 0x04;

/** Fields the ULA blinks over: it inverts flashed text for 32 of every 64. */
const BLINK_FIELDS = 32;

export class OricUla {
  /** ABGR framebuffer, border included. */
  readonly pixels: Uint32Array = new Uint32Array(ORIC_SCREEN_WIDTH * ORIC_SCREEN_HEIGHT);
  /** The same buffer as the RGBA byte view the renderer uploads. */
  get pixelBytes(): Uint8Array { return this.pixelView; }
  private readonly pixelView: Uint8Array;

  /** The mode register: hires and the 50/60 Hz select. Persists across lines
   *  and across frames, as the ULA's own register does. */
  mode = 0;
  /** Fields counted since reset, for the blink clock. */
  fieldCounter = 0;

  constructor(private readonly memory: OricMemory) {
    this.pixelView = new Uint8Array(this.pixels.buffer);
    this.pixels.fill(ORIC_PALETTE[0]);
  }

  get hires(): boolean { return (this.mode & MODE_HIRES) !== 0; }
  get sixtyHz(): boolean { return (this.mode & MODE_60HZ) !== 0; }

  /** True while the blink clock has flashed areas drawn in paper. */
  private get blinkPhase(): boolean { return (this.fieldCounter & BLINK_FIELDS) !== 0; }

  beginFrame(): void {
    this.pixels.fill(ORIC_PALETTE[0]);
  }

  /** One field has been displayed: step the blink clock. */
  endFrame(): void {
    this.fieldCounter = (this.fieldCounter + 1) & (BLINK_FIELDS * 2 - 1);
  }

  /**
   * Draw one displayed line (0 to 223). The whole 40-byte row is fetched as
   * the line starts, so a register the program changes between lines is seen
   * on the next line — the ULA's real behaviour.
   */
  renderLine(line: number): void {
    if (line < 0 || line >= ORIC_ACTIVE_HEIGHT) return;

    // Per-line registers, as the ULA resets them at the start of every line.
    // Per-line ink/style/paper reset, but the mode register persists across
    // lines and frames — it is the one the ULA keeps.
    let ink = ORIC_RESET_INK;
    let paper = ORIC_RESET_PAPER;
    let style = 0;

    // Sampled once at the start of the line: a mode attribute written *during*
    // the line takes effect from the next one, which is what the hardware does
    // (the ULA commits its mode register at the line boundary).
    const hiresLine = this.hires && line < ORIC_HIRES_LAST_LINE;

    const textRow = line >> 3;
    const base = hiresLine
      ? ORIC_HIRES_SCREEN + line * ORIC_TEXT_COLS
      : ORIC_TEXT_SCREEN + textRow * ORIC_TEXT_COLS;

    const out = (line + ORIC_BORDER_TOP) * ORIC_SCREEN_WIDTH + ORIC_BORDER_LEFT;
    const blink = this.blinkPhase;

    for (let col = 0; col < ORIC_TEXT_COLS; col++) {
      const ch = this.memory.ram[(base + col) & 0xFFFF];
      const x = out + col * ORIC_CELL_WIDTH;

      // A serial attribute: bits 5 and 6 both clear. It updates a register and
      // then draws its own cell in the (possibly new) paper colour.
      if ((ch & 0x60) === 0) {
        switch (ch & 0x18) {
          case 0x00: ink = ch & 7; break;
          case 0x08: style = ch & 7; break;
          case 0x10: paper = ch & 7; break;
          case 0x18: this.mode = ch & 7; break;
        }
        this.drawCell(x, paper, paper, 0);
        continue;
      }

      let bits: number;
      if (hiresLine) {
        // Six pixels in the low bits, most significant leftmost.
        bits = ch & 0x3F;
      } else {
        const charsetBase = (style & STYLE_ALT_CHARSET) !== 0
          ? ORIC_CHARSET_TEXT_ALT : ORIC_CHARSET_TEXT;
        const index = ch & 0x7F;
        bits = this.memory.ram[(charsetBase + index * 8 + this.glyphRow(style, line)) & 0xFFFF] & 0x3F;
      }

      // Bit 7 inverts foreground and paper for this cell.
      const inverse = (ch & 0x80) !== 0;
      const fg = inverse ? paper : ink;
      const bg = inverse ? ink : paper;
      const flashed = (style & STYLE_BLINK) !== 0 && blink;
      this.drawCell(x, flashed ? bg : fg, bg, bits);
    }
  }

  /**
   * Which of a glyph's eight scanlines a displayed line shows.
   *
   * Double height does not scale the glyph up from one row: it makes each
   * scanline cover *two* displayed lines, so a character spans two character
   * rows (16 lines) instead of one. The plain form is `(line >> 1) & 7`.
   *
   * The consequence is the ROM's documented quirk: because the halving is
   * aligned to the screen rather than to the text block, a double-height block
   * that starts on an odd line shows its bottom half above its top half. That
   * is reproduced deliberately rather than corrected — it is what the hardware
   * does, and software written around it would break if we "fixed" it.
   */
  private glyphRow(style: number, line: number): number {
    if ((style & STYLE_DOUBLE_HEIGHT) === 0) return line & 7;
    return (line >> 1) & 7;
  }

  /** Six pixels of a cell, from the bitmap's bits 5..0. */
  private drawCell(x: number, fg: number, bg: number, bits: number): void {    const px = this.pixels;
    const fgColour = ORIC_PALETTE[fg & 7];
    const bgColour = ORIC_PALETTE[bg & 7];
    for (let i = 0; i < ORIC_CELL_WIDTH; i++) {
      px[x + i] = (bits & (1 << (ORIC_CELL_WIDTH - 1 - i))) !== 0 ? fgColour : bgColour;
    }
  }

  /** The 6x8 text cell a column/row pair occupies, for the OCR overlay. */
  static cellRect(col: number, row: number): { x: number; y: number; width: number; height: number } {
    return {
      x: ORIC_BORDER_LEFT + col * ORIC_CELL_WIDTH,
      y: ORIC_BORDER_TOP + row * ORIC_CELL_HEIGHT,
      width: ORIC_CELL_WIDTH,
      height: ORIC_CELL_HEIGHT,
    };
  }

  /** The visible active area. */
  static get activeRect(): { x: number; y: number; width: number; height: number } {
    return {
      x: ORIC_BORDER_LEFT, y: ORIC_BORDER_TOP,
      width: ORIC_ACTIVE_WIDTH, height: ORIC_ACTIVE_HEIGHT,
    };
  }

  /** Blank the cells a transcription overlay has replaced. */
  blankCells(mask: readonly boolean[]): void {
    const black = ORIC_PALETTE[0];
    for (let row = 0; row * ORIC_TEXT_COLS < mask.length; row++) {
      for (let col = 0; col < ORIC_TEXT_COLS; col++) {
        if (!mask[row * ORIC_TEXT_COLS + col]) continue;
        const r = OricUla.cellRect(col, row);
        for (let y = r.y; y < r.y + r.height; y++) {
          const at = y * ORIC_SCREEN_WIDTH + r.x;
          this.pixels.fill(black, at, at + r.width);
        }
      }
    }
  }

  reset(): void {
    this.mode = 0;
    this.fieldCounter = 0;
    this.pixels.fill(ORIC_PALETTE[0]);
  }
}
