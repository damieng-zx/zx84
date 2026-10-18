/**
 * Apple II video character-generator ROMs.
 *
 * Two generations of hardware, behind one interface so the renderer does not
 * care which it is drawing:
 *
 *  - {@link Apple2Charset} — the ][ and ][+'s 2513 (64 glyphs, `$20-$5F`). The
 *    video hardware addresses it by a six-bit character code (screen byte bits
 *    0-5) and a three-bit glyph row; flash and inverse come from the byte's top
 *    two bits and are applied here, not stored.
 *  - {@link Apple2eCharset} — the IIe's 2K video ROM: 256 glyphs, with the
 *    lowercase shapes the alternate character set shows.
 *
 * `glyph()` returns the seven dots of one glyph row, bit 6 leftmost, lit = 1.
 * The ROM is a machine ROM fetched like the others (see the machine's
 * `prepare()`); without it text renders blank rather than throwing, so the
 * machine still boots (to a blank screen) if the image is unavailable.
 */

import { APPLE2_CHARGEN_SIZE } from './models.ts';

/** What the text renderer needs from a character generator. */
export interface Apple2Font {
  readonly loaded: boolean;
  load(rom: Uint8Array): void;
  /**
   * Seven dots (bit 6 leftmost, 1 = lit) of glyph row `row` for screen byte
   * `code`, with inverse and flash applied. `flashPhase` is the current flash
   * state; `altCharset` selects the IIe's alternate set (ignored by the ][+).
   */
  glyph(code: number, row: number, flashPhase: boolean, altCharset: boolean): number;
}

export class Apple2Charset implements Apple2Font {
  private readonly rom = new Uint8Array(APPLE2_CHARGEN_SIZE);
  private present = false;

  get loaded(): boolean { return this.present; }

  load(rom: Uint8Array): void {
    this.rom.fill(0);
    this.rom.set(rom.subarray(0, APPLE2_CHARGEN_SIZE));
    this.present = true;
  }

  /** The seven pixels of one glyph row, bit 6 leftmost — or 0 with no ROM. */
  glyphRow(code: number, row: number): number {
    if (!this.present) return 0;
    return this.rom[(((code & 0x3F) << 3) | (row & 7)) & (APPLE2_CHARGEN_SIZE - 1)];
  }

  glyph(code: number, row: number, flashPhase: boolean): number {
    // Attributes are in the top two bits: $80-$FF normal, $40-$7F flashing
    // (alternating normal/inverse), $00-$3F inverse. The glyph is the low six.
    const hi = code & 0xC0;
    const inverse = hi === 0x00 || (hi === 0x40 && flashPhase);
    const bits = this.glyphRow(code, row);
    return inverse ? (~bits & 0x7F) : bits;
  }

  /** Raw ROM byte view (for tests / diagnostics). */
  get bytes(): Uint8Array { return this.rom; }
}

/** Reverse the low seven bits (the IIe ROM stores its leftmost dot in bit 0). */
function reverse7(v: number): number {
  let out = 0;
  for (let i = 0; i < 7; i++) out |= ((v >> i) & 1) << (6 - i);
  return out;
}

const IIE_CHARGEN_SIZE = 0x800;

/**
 * The unenhanced IIe's video ROM: 256 glyphs of eight rows, the leftmost dot in
 * bit 0, and a dot is lit where the ROM bit is *clear*. Codes `$00-$7F` are
 * stored in inverse video and `$80-$FF` in normal video, so the stored polarity
 * is already the screen's; only a flashing character needs flipping on the
 * other half of the flash cycle.
 *
 * With the alternate character set off (the power-on state) the IIe shows what
 * a ][+ does: `$40-$7F` flash and lowercase codes display as upper case. With it
 * on, `$60-$7F`/`$E0-$FF` show the lowercase shapes and nothing flashes.
 */
export class Apple2eCharset implements Apple2Font {
  private readonly rom = new Uint8Array(IIE_CHARGEN_SIZE);
  private present = false;

  get loaded(): boolean { return this.present; }

  load(rom: Uint8Array): void {
    this.rom.fill(0xFF);
    this.rom.set(rom.subarray(0, IIE_CHARGEN_SIZE));
    this.present = true;
  }

  glyph(code: number, row: number, flashPhase: boolean, altCharset: boolean): number {
    if (!this.present) return 0;
    let romCode = code;
    let flashing = false;
    if (!altCharset) {
      if ((code & 0xC0) === 0x40) {
        flashing = true;
        if (code >= 0x60) romCode = code - 0x40;       // flashing symbols, not lowercase
      } else if (code >= 0xE0) {
        romCode = code - 0x20;                         // lowercase codes show as upper case
      }
    }
    let lit = ~this.rom[((romCode << 3) | (row & 7)) & (IIE_CHARGEN_SIZE - 1)] & 0x7F;
    if (flashing && !flashPhase) lit = ~lit & 0x7F;
    return reverse7(lit);
  }

  get bytes(): Uint8Array { return this.rom; }
}
