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

/** PAL field rate. */
export const ACE_FRAME_HZ = 50;

/** Nominal T-states per frame (3.25 MHz / 50 Hz). */
export const ACE_T_PER_FRAME = Math.round(ACE_CPU_CLOCK / ACE_FRAME_HZ);

/** PAL scanlines per field (the CPU budget is 65000T; 312 × 208.33T). */
export const ACE_LINES_PER_FRAME = 312;

/** Active display lines (24 character rows × 8 scanlines). */
export const ACE_ACTIVE_LINES = 192;

/** Border padding around the 256×192 active display (a clean 320×240 window). */
export const ACE_BORDER_LEFT = 32;
export const ACE_BORDER_TOP = 24;

/** Output RGBA buffer geometry (active area + border). */
export const ACE_SCREEN_WIDTH = 320;
export const ACE_SCREEN_HEIGHT = 240;

/** The ULA holds /INT low for this many T-states each frame (Spectrum-style
 *  pulse; one interrupt per frame, lost if the CPU is masking them). */
export const ACE_INT_LENGTH_T = 26;

/** ROM space: 8KB of FORTH ROM at 0x0000. */
export const ACE_ROM_SIZE = 0x2000;

/** Per-chip sizes: video RAM, character RAM and main RAM are each 1KB. */
export const ACE_VRAM_BASE = 0x2400;   // screen file 0x2400-0x26FF
export const ACE_CHARRAM_BASE = 0x2C00; // glyph table, 128 × 8 bytes
export const ACE_RAM_BASE = 0x3C00;     // 1KB main RAM (FORTH stacks at top)
