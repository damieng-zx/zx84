/**
 * Apple II video character-generator ROM wrapper.
 *
 * The video hardware addresses the character ROM by a six-bit character code
 * (screen byte bits 0-5) and a three-bit glyph row: `glyph = code * 8 + row`.
 * Each ROM byte carries the seven pixels of that row (bits 6-0, MSB leftmost);
 * flash and inverse are applied by the renderer, not stored here.
 *
 * The ROM is a machine ROM fetched like the others (see the machine's
 * `prepare()`); without it text renders blank rather than throwing, so the
 * machine still boots (to a blank screen) if the image is unavailable.
 */

import { APPLE2_CHARGEN_SIZE } from './models.ts';

export class Apple2Charset {
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

  /** Raw ROM byte view (for tests / diagnostics). */
  get bytes(): Uint8Array { return this.rom; }
}
