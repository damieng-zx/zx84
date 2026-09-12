/**
 * Jupiter Ace hardware constants.
 *
 * The Ace is a Z80A at 3.25 MHz (6.5 MHz XTAL / 2) driving a 32×24 monochrome
 * text ULA at PAL 50 Hz. Memory decode (MAME cantab/jupace.cpp — A12-A14 are
 * the only decoded lines above ROM, each 1KB chip mirrors through its unconnected
 * address bits):
 *
 *   0000-1FFF  8KB FORTH ROM (two 4KB chips, no mirror)
 *   2000-27FF  Video RAM 1KB  (screen file 2400-26FF, linear; A10 undecoded)
 *   2800-2FFF  Char RAM 1KB   (128 glyphs × 8 rows; A10 undecoded)
 *   3000-3FFF  Main RAM 1KB   (A10/A11 undecoded)
 *   4000-FFFF  RAM expansion sockets (unpopulated → open bus)
 *
 * The screen file is a plain linear 768-byte table (NOT the Spectrum's
 * third-interleaved scramble — the Ace ULA counts cells, not pixel rows), and
 * character code bit 7 is an inverse-video flag, so the char generator only
 * ever addresses glyphs 0-127.
 */

/** Z80 clock (Hz) — 6.5 MHz crystal / 2. */
export const ACE_CPU_CLOCK = 3_250_000;

/** Nominal PAL field rate. The field the ULA actually draws is 312 × 208T,
 *  which at 3.25 MHz comes out at 50.08 Hz — see ACE_T_PER_FRAME below. */
export const ACE_FRAME_HZ = 50;

/** PAL scanlines per field. */
export const ACE_LINES_PER_FRAME = 312;

/** T-states per scanline: the 6.5 MHz dot clock draws 416 pixels a line, and
 *  the CPU runs at half that (MAME's screen.set_raw(6.5_MHz, 416, …, 312)). */
export const ACE_T_PER_LINE = 208;

/** T-states per frame — the field's real length, 312 × 208T = 64896T, not the
 *  3.25MHz/50Hz round number. The difference is 104T a frame (0.16%), and the
 *  field rate that follows is 50.08 Hz, as on the hardware. */
export const ACE_T_PER_FRAME = ACE_LINES_PER_FRAME * ACE_T_PER_LINE;

/** Active display lines (24 character rows × 8 scanlines). */
export const ACE_ACTIVE_LINES = 192;

/** Border padding around the 256×192 active display (a clean 320×240 window). */
export const ACE_BORDER_LEFT = 32;
export const ACE_BORDER_TOP = 24;

/** Output RGBA buffer geometry (active area + border). */
export const ACE_SCREEN_WIDTH = 320;
export const ACE_SCREEN_HEIGHT = 240;

/** How long the ULA holds /INT low each frame. Not the Spectrum's brief
 *  pulse: the Ace asserts it for the eight scanlines of vertical sync (MAME
 *  raises the IRQ at line 31×8 = 248 and clears it at 32×8 = 256), so
 *  8 × 208T. A CPU that is masking interrupts therefore has a whole 1664T to
 *  re-enable them and still take the frame's interrupt — at 26T a DI stretch
 *  of more than a few instructions silently lost it until the next field.
 *  Still one interrupt per frame here: the pulse is a deadline, not a level
 *  the CPU can re-trigger on. */
export const ACE_INT_LENGTH_T = 8 * ACE_T_PER_LINE;

/** ROM space: 8KB of FORTH ROM at 0x0000. */
export const ACE_ROM_SIZE = 0x2000;

/** Per-chip sizes: video RAM, character RAM and main RAM are each 1KB. */
export const ACE_VRAM_BASE = 0x2400;   // screen file 0x2400-0x26FF
export const ACE_CHARRAM_BASE = 0x2C00; // glyph table, 128 × 8 bytes
export const ACE_RAM_BASE = 0x3C00;     // 1KB main RAM (FORTH stacks at top)
