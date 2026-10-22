/**
 * The Apple I's character generator.
 *
 * A Signetics 2513 holds 64 glyphs ($20-$5F): the terminal addresses it by the
 * low six bits of the character code and a glyph row. The Apple ][ used the same
 * part for its text mode, so the ROM image is shared with it: eight bytes per
 * glyph, seven dots a row with bit 6 leftmost and a lit dot set. Without the ROM
 * text renders blank rather than throwing, so the machine still runs.
 */

const CHARGEN_SIZE = 0x200;

export class Apple1Charset {
  private readonly rom = new Uint8Array(CHARGEN_SIZE);
  private present = false;
  /** Bumped when a ROM is loaded, so a renderer knows its drawing is stale. */
  generation = 0;

  get loaded(): boolean { return this.present; }

  load(rom: Uint8Array): void {
    this.rom.fill(0);
    this.rom.set(rom.subarray(0, CHARGEN_SIZE));
    this.present = true;
    this.generation++;
  }

  /** The seven dots (bit 6 leftmost) of glyph row `row` for character `code`. */
  glyphRow(code: number, row: number): number {
    if (!this.present) return 0;
    return this.rom[((code & 0x3F) << 3) | (row & 7)];
  }
}
