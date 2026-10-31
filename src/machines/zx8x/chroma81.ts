/**
 * The Chroma 81 colour interface (Paul Farrow), per its Technical
 * Description:
 *
 *   OUT $7FEF  %00EMIGRB — E enables colour, M picks the mode (0 character
 *              code, 1 attribute file), IGRB is the border colour
 *   IN  $7FEF  bit 5 low when the colour modes are available; other bits high
 *
 * Its 16K of RAM appears at $C000-$FFFF (where the ZX81 would otherwise echo
 * $4000-$7FFF). In character code mode a 1K table at $C000 colours each of
 * the 64 characters and their 64 inverse forms line by line ($C000 + 8 x
 * code + line, inverse codes after the normal ones). In attribute file mode
 * each display-file byte at D is coloured by the byte at D | $C000, so the
 * attribute file has the display file's shape 32K above it.
 *
 * A colour byte is %IGRBigrb: paper in the high nibble, ink in the low, each
 * a bright bit and green/red/blue. Bright is full level, normal 69%; bright
 * black is black.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

export const CHROMA_PORT = 0x7fef;
export const CHROMA_RAM_BASE = 0xc000;

const DIM = Math.round(0xff * 0.69);

/** Frame-buffer colours (ABGR, as the frame's Uint32 view stores them) for
 *  the 16 IGRB values. */
export const CHROMA_PALETTE: Uint32Array = (() => {
  const out = new Uint32Array(16);
  for (let c = 0; c < 16; c++) {
    const level = c & 8 ? 0xff : DIM;
    const r = c & 2 ? level : 0;
    const g = c & 4 ? level : 0;
    const b = c & 1 ? level : 0;
    out[c] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  return out;
})();

export class Chroma81 {
  /** The control register's six defined bits. */
  control = 0;
  readonly ram = new Uint8Array(0x4000);

  get colourOn(): boolean { return (this.control & 0x20) !== 0; }
  get attributeMode(): boolean { return (this.control & 0x10) !== 0; }
  get border(): number { return CHROMA_PALETTE[this.control & 0x0f]; }

  write(value: number): void { this.control = value & 0x3f; }

  /** Bit 5 low: the colour modes are available. */
  read(): number { return 0xdf; }

  /** The reset button clears the colour mappings (they survive NEW and RAND
   *  USR 0, not a reset) and turns colour off. */
  reset(): void {
    this.control = 0;
    this.ram.fill(0);
  }

  saveState(w: StateWriter): void {
    w.u8(this.control);
    w.raw(this.ram);
  }

  loadState(r: StateReader): void {
    this.control = r.u8() & 0x3f;
    r.rawInto(this.ram);
  }
}
