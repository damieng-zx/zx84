/**
 * Timex SCLD (the TC2048's ULA): the state behind port 0xFF, the "DEC" register.
 *
 * Bits of the byte written to port 0xFF:
 *   0-2  screen mode (see below)
 *   3-5  hi-res colour: the ink is this value, the paper its complement (7 - ink),
 *        both bright, and the border takes the paper colour
 *   6    set: the frame interrupt is disabled (a hardware DI that EI cannot undo)
 *   7    selects the EX-ROM (1) or the DOCK (0) for the horizontal MMU; nothing on
 *        the TC2048 can use it, so it is only remembered
 * Reading the port returns the last byte written. Both 0xFF and the ULA's 0xFE
 * are decoded on the low eight address bits.
 *
 * Screen modes (bit 2 = hi-res; "screen 0" is the bitmap and attributes at
 * 0x4000, "screen 1" the same layout at 0x6000):
 *   0  screen 0                                       256x192, 8x8 attributes
 *   1  screen 1                                       256x192, 8x8 attributes
 *   2  screen 0 bitmap, 8x1 attributes read from the  256x192, "hi-colour"
 *      bitmap layout of screen 1
 *   3  screen 1 bitmap, attributes read from that same bitmap layout (an
 *      oddity of the hardware: the bitmap byte is also its own attribute)
 *   4  hi-res: screen 0 bitmap bytes alternate with   512x192, monochrome
 *      the attribute-area bytes of screen 0
 *   5  hi-res: screen 1 bitmap bytes alternate with   512x192, monochrome
 *      the attribute-area bytes of screen 1
 *   6  hi-res: screen 0 and screen 1 bitmap bytes     512x192, monochrome
 *      alternate (the usual hi-res mode)
 *   7  hi-res: screen 1 bitmap bytes, each twice      512x192, monochrome
 */

export class Scld {
  /** The last byte written to port 0xFF. */
  dec = 0;

  /** Port 0xFF bits 0-2. */
  get screenMode(): number { return this.dec & 7; }
  get hiRes(): boolean { return (this.dec & 0x04) !== 0; }
  /** Bits 3-5: the hi-res ink colour (the paper is 7 - ink). */
  get hiResInk(): number { return (this.dec >> 3) & 7; }
  get interruptDisabled(): boolean { return (this.dec & 0x40) !== 0; }
  /** Bit 7: EX-ROM (true) or DOCK (false). */
  get exRom(): boolean { return (this.dec & 0x80) !== 0; }

  write(value: number): void { this.dec = value & 0xff; }
  reset(): void { this.dec = 0; }
}
