/**
 * Memotech FDX 80-column display board.
 *
 * The board has a Motorola 6845, 2K character RAM, 2K attribute RAM and a
 * dedicated 8×10 character generator. Character/attribute RAM is accessed
 * through latches rather than the Z80 address space:
 *
 *   30h address low (and write strobe)
 *   31h address high + write masks
 *   32h character data
 *   33h attribute data
 *   38h 6845 register select
 *   39h 6845 register data
 */

import { Crtc6845 } from '@/cores/crtc-6845.ts';

export const MTX_80_COLUMN_WIDTH = 640;
export const MTX_80_COLUMN_HEIGHT = 240;
export const MTX_80_COLUMN_COLS = 80;
export const MTX_80_COLUMN_ROWS = 24;

const GLYPH_WIDTH = 8;
const GLYPH_HEIGHT = 10;
const RAM_MASK = 0x07FF;

const ATTR_FOREGROUND = 0x07;
const ATTR_BACKGROUND = 0x38;
const ATTR_BLINK = 0x40;
const ATTR_GRAPHICS = 0x80;

const packRgb = (hex: number): number =>
  ((0xFF000000 | ((hex & 0xFF) << 16) | (hex & 0xFF00) | ((hex >> 16) & 0xFF)) >>> 0);

const PALETTE = Uint32Array.from([
  0x000000, 0xFF0000, 0x00FF00, 0xFFFF00,
  0x0000FF, 0xFF00FF, 0x00FFFF, 0xFFFFFF,
].map(packRgb));

/**
 * MEMU's reconstructed FDX alpha character PROM, transcribed from the FDX
 * manual: 256 glyphs × 10 rows. Stored compactly to keep the board logic
 * readable; the graphics PROM is generated from character-code mosaic bits.
 */
const ALPHA_PROM_BASE64 =
  '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AAQMFCQ+BAQAAAA+IDwCAiIcAAAADhAgPCIiHAAAAD4CBAgQEBAAAAAcIiIcIiIcAAAAHiIiHgIEOAAAAAAAAAAQABAAAAAAAAAIAAgIEAAABAgQIBAIBAAAAAAAPAA8AAAAAAAgEAgECBAgAAAAHCICBAgACAAAABwiLiouIBwAAAAIFCIiPiIiAAAAPCIiPCIiPAAAABwiICAgIhwAAAA8EhISEhI8AAAAPiAgPCAgPgAAAD4gIDwgICAAAAAcIiAgJiIeAAAAIiIiPiIiIgAAABwICAgICBwAAAACAgICIiIcAAAAIiQoMCgkIgAAACAgICAgID4AAAAiNioqIiIiAAAAIiIyKiYiIgAAABwiIiIiIhwAAAA8IiI8ICAgAAAAHCIiIiokGgAAADwiIjwoJCIAAAAcIiAcAiIcAAAAPggICAgICAAAACIiIiIiIhwAAAAiIiIUFAgIAAAAIiIiKioqFAAAACIiFAgUIiIAAAAiIhQICAgIAAAAPgIECBAgPgAAAAAIED4QCAAAAAAQMBAQBAoCBAoAAAgEPgQIAAAAAAgcKggICAgAAAAAAAAAAAA+AAAAAAAAPgAAAAAAAAAAHAIeIh4AAAAgIDwiIiI8AAAAAAAeICAgHgAAAAICHiIiIh4AAAAAABwiPiAcAAAABAgIHAgICAAAAAAAHiIiIh4CDAAgIDwiIiIiAAAAAAgACAgICAAAAAAIAAgICAgIEAAgICQoMCgkAAAACAgICAgICAAAAAAANCoqKioAAAAAADwiIiIiAAAAAAAcIiIiHAAAAAAAPCIiIjwgIAAAAB4iIiIeAgIAAAAuMCAgIAAAAAAAHiAcAjwAAAAACBwICAgEAAAAAAAiIiIiHgAAAAAAIiIUFAgAAAAAACIiIioUAAAAAAAiFAgUIgAAAAAAIiIiIh4CDgAAAD4ECBA+AAAAEDAQEAIGCh4CADY2NjY2NjYAAAAwCDAIMgYKHgIAAAgAPgAIAAAAAD4+Pj4+Pj4AAA==';

const ALPHA_PROM = Uint8Array.from(atob(ALPHA_PROM_BASE64), ch => ch.charCodeAt(0));

function graphicRow(char: number, row: number): number {
  const pair = row < 3 ? 0 : row < 5 ? 1 : row < 7 ? 2 : 3;
  const left = char & (1 << (pair * 2));
  const right = char & (1 << (pair * 2 + 1));
  return (left ? 0xF0 : 0) | (right ? 0x0F : 0);
}

export class Mtx80ColumnCard {
  readonly crtc = new Crtc6845(0);
  readonly characters = new Uint8Array(0x800);
  readonly attributes = new Uint8Array(0x800);
  readonly pixels = new Uint8Array(MTX_80_COLUMN_WIDTH * MTX_80_COLUMN_HEIGHT * 4);
  private readonly pixels32 = new Uint32Array(this.pixels.buffer);

  enabled = false;
  private addressLow = 0;
  private addressHigh = 0;
  private characterData = 0;
  private attributeData = 0;
  private frame = 0;

  get address(): number {
    return (((this.addressHigh & 0x07) << 8) | this.addressLow) & RAM_MASK;
  }

  reset(): void {
    this.crtc.reset();
    this.characters.fill(0);
    this.attributes.fill(0);
    this.addressLow = 0;
    this.addressHigh = 0;
    this.characterData = 0;
    this.attributeData = 0;
    this.frame = 0;
    this.pixels32.fill(PALETTE[0]);
  }

  write(port: number, value: number): void {
    value &= 0xFF;
    switch (port & 0xFF) {
      case 0x30:
        this.addressLow = value;
        if (this.addressHigh & 0x80) {
          const address = this.address;
          if (this.addressHigh & 0x40) this.characters[address] = this.characterData;
          if (this.addressHigh & 0x20) this.attributes[address] = this.attributeData;
        }
        break;
      case 0x31: this.addressHigh = value; break;
      case 0x32: this.characterData = value; break;
      case 0x33: this.attributeData = value; break;
      case 0x38: this.crtc.selectRegister(value); break;
      case 0x39:
        if (this.crtc.selectedRegister < 16) this.crtc.writeRegister(value);
        break;
    }
  }

  read(port: number): number {
    switch (port & 0xFF) {
      case 0x30: return 0xFF; // the documented read action rings the terminal bell
      case 0x32: return (this.addressHigh & 0x80) === 0
        ? this.characters[this.address]
        : 0xFF;
      case 0x33: return (this.addressHigh & 0x80) === 0
        ? this.attributes[this.address]
        : 0xFF;
      case 0x38: return this.crtc.selectedRegister;
      case 0x39: return this.crtc.selectedRegister < 16
        ? this.crtc.readRegister()
        : 0xFF;
      default: return 0xFF;
    }
  }

  renderFrame(): void {
    const regs = this.crtc.regs;
    const start = (((regs[12] & 0x07) << 8) | regs[13]) & RAM_MASK;
    const cursor = (((regs[14] & 0x07) << 8) | regs[15]) & RAM_MASK;
    const cursorMode = regs[10] & 0x60;
    const cursorVisible = cursorMode === 0 ||
      (cursorMode === 0x40 && (this.frame & 0x10) === 0) ||
      (cursorMode === 0x60 && (this.frame & 0x20) === 0);
    const cursorStart = regs[10] & 0x1F;
    const cursorEnd = regs[11] & 0x1F;
    const blinkBlank = (this.frame & 0x20) !== 0;

    for (let row = 0; row < MTX_80_COLUMN_ROWS; row++) {
      for (let col = 0; col < MTX_80_COLUMN_COLS; col++) {
        const address = (start + row * MTX_80_COLUMN_COLS + col) & RAM_MASK;
        const char = this.characters[address];
        const attr = this.attributes[address];
        const fg = PALETTE[attr & ATTR_FOREGROUND];
        const bg = PALETTE[(attr & ATTR_BACKGROUND) >> 3];
        const blank = blinkBlank && (attr & ATTR_BLINK) !== 0;
        const glyphBase = char * GLYPH_HEIGHT;

        for (let glyphRow = 0; glyphRow < GLYPH_HEIGHT; glyphRow++) {
          let bits = blank
            ? 0
            : (attr & ATTR_GRAPHICS) !== 0
              ? graphicRow(char, glyphRow)
              : ALPHA_PROM[glyphBase + glyphRow];
          const cursorRaster = cursorVisible && address === cursor &&
            glyphRow >= cursorStart && glyphRow <= cursorEnd;
          const pixelBase =
            (row * GLYPH_HEIGHT + glyphRow) * MTX_80_COLUMN_WIDTH +
            col * GLYPH_WIDTH;
          for (let x = 0; x < GLYPH_WIDTH; x++) {
            this.pixels32[pixelBase + x] = cursorRaster || (bits & 0x80) !== 0 ? fg : bg;
            bits <<= 1;
          }
        }
      }
    }
    this.frame++;
  }

  text(): string {
    const start = this.crtc.displayStart & RAM_MASK;
    const rows: string[] = [];
    for (let row = 0; row < MTX_80_COLUMN_ROWS; row++) {
      let line = '';
      for (let col = 0; col < MTX_80_COLUMN_COLS; col++) {
        const char = this.characters[(start + row * MTX_80_COLUMN_COLS + col) & RAM_MASK];
        line += char >= 0x20 && char < 0x7F ? String.fromCharCode(char) : ' ';
      }
      rows.push(line.trimEnd());
    }
    return rows.join('\n');
  }
}
