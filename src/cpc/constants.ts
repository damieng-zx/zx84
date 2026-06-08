/**
 * Amstrad CPC hardware constants.
 *
 * Kept separate from the Spectrum's `cores/ula.ts` geometry so neither machine
 * pollutes the other. All timing is derived from the CPC's 16 MHz master clock:
 *   - Z80 CLK     = 16 / 4  = 4 MHz   (1 µs = 4 T-states)
 *   - CRTC CLK    = 16 / 16 = 1 MHz   (1 character = 1 µs = 4 T-states)
 *   - Pixel clock = 16 MHz            (16 Gate-Array pixels per character)
 */

/** Z80 clock (Hz). */
export const CPC_CPU_CLOCK = 4_000_000;

/** Master/pixel clock (Hz). */
export const CPC_MASTER_CLOCK = 16_000_000;

/** T-states per CRTC character (1 µs at 4 MHz). */
export const CPC_T_PER_CHAR = 4;

/** Gate-Array pixels emitted per CRTC character (16 MHz / 1 MHz). */
export const CPC_PIXELS_PER_CHAR = 16;

/** AY-3-8912 clock on the CPC (Hz). */
export const CPC_AY_CLOCK = 1_000_000;

/** Firmware cassette-manager jumpblock entry for CAS READ ("read one block",
 *  HL=dest, DE=len, A=sync). The instant-load trap watches for execution
 *  reaching this address: every CAS READ — software CALLs and the firmware's own
 *  reads after |TAPE — routes through here (that indirection is how |TAPE/|DISC
 *  redirection works), so trapping it catches BASIC loads too. */
export const CPC_CAS_READ_JUMP = 0xBCA1;

/**
 * Nominal frame length in T-states for the default CRTC programming
 * (64 chars/line × 312 lines × 4 T = 79 872 T → 50.08 Hz). The real frame
 * boundary is driven by the CRTC's VSYNC; this is only the resync target and
 * the headless tick budget, mirroring the Spectrum's `tStatesPerFrame`.
 */
export const CPC_T_PER_FRAME = 64 * 312 * CPC_T_PER_CHAR;

/**
 * Output RGBA buffer geometry. The Gate Array is sampled at its 16 MHz pixel
 * clock, so one displayed character spans 16 horizontal pixels regardless of
 * screen mode (mode 0/1/2 differ in how many logical pixels share those 16
 * clocks). 48 characters wide × 16 = 768 captures the 40-char active area plus
 * a generous border; 272 lines covers 200 active rows plus top/bottom border.
 * Refined in the video phase if overscan needs more.
 */
export const CPC_SCREEN_WIDTH = 768;
export const CPC_SCREEN_HEIGHT = 272;

/** Left/top offset of the 640×200 active area within the CRT window. */
export const CPC_BORDER_LEFT = (CPC_SCREEN_WIDTH - 640) >> 1;  // 64
export const CPC_BORDER_TOP = (CPC_SCREEN_HEIGHT - 200) >> 1;  // 36

/**
 * CPC hardware colour maps. Index = the 5-bit value written by the colour
 * command (0–31); value = packed ABGR (0xAABBGGRR — the word order the canvas /
 * WebGL renderers consume, matching `PALETTES` in cores/ula.ts).
 *
 * Three variants are offered, analogous to the Spectrum's basic/measured/vivid:
 *   - `basic`      — idealized levels: the ASIC 12-bit register value (G/R/B
 *                    nibbles 0/6/F) expanded to 24 bits. Clean, what most
 *                    emulators show.
 *   - `gate-array` — measured RGB output of the original Gate Array (the colour
 *                    a real 464/664/6128 monitor produces).
 *   - `asic`       — measured RGB output of the Plus ASIC (40226).
 *
 * Source: grimware Gate-Array/ASIC colour table. The rows there are keyed by the
 * firmware colour number; the tables below are re-keyed to the hardware value
 * (the BASIC register byte & 0x1F) so they index directly off `pens[]`.
 */
export type CpcColorMap = 'basic' | 'gate-array' | 'asic';

const packRgb = (hex: number): number =>
  ((0xFF000000 | ((hex & 0xFF) << 16) | (hex & 0xFF00) | ((hex >> 16) & 0xFF)) >>> 0);

const buildCpcPalette = (rgb: readonly number[]): Uint32Array => {
  const out = new Uint32Array(32);
  for (let i = 0; i < 32; i++) out[i] = packRgb(rgb[i]);
  return out;
};

// All three arrays are indexed 0–31 by hardware value (not firmware colour).
export const CPC_PALETTES: Record<CpcColorMap, Uint32Array> = {
  basic: buildCpcPalette([
    0x666666, 0x666666, 0x00FF66, 0xFFFF66, 0x000066, 0xFF0066, 0x006666, 0xFF6666,
    0xFF0066, 0xFFFF66, 0xFFFF00, 0xFFFFFF, 0xFF0000, 0xFF00FF, 0xFF6600, 0xFF66FF,
    0x000066, 0x00FF66, 0x00FF00, 0x00FFFF, 0x000000, 0x0000FF, 0x006600, 0x0066FF,
    0x660066, 0x66FF66, 0x66FF00, 0x66FFFF, 0x660000, 0x6600FF, 0x666600, 0x6666FF,
  ]),
  'gate-array': buildCpcPalette([
    0x6E7D6B, 0x6E7B6D, 0x00F36B, 0xF3F36D, 0x00026B, 0xF00268, 0x007868, 0xF37D6B,
    0xF30268, 0xF3F36B, 0xF3F30D, 0xFFF3F9, 0xF30506, 0xF302F4, 0xF37D0D, 0xFA80F9,
    0x000268, 0x02F36B, 0x02F001, 0x0FF3F2, 0x000201, 0x0C02F4, 0x027801, 0x0C7BF4,
    0x690268, 0x71F36B, 0x71F504, 0x71F3F4, 0x6C0201, 0x6C02F2, 0x6E7B01, 0x6E7BF6,
  ]),
  asic: buildCpcPalette([
    0x686764, 0x666662, 0x04F562, 0xFDF563, 0x050663, 0xFF0764, 0x046764, 0xFD6763,
    0xFB0562, 0xFBF361, 0xFEF504, 0xFDF5F0, 0xFD0704, 0xFD07F2, 0xFD6704, 0xFD67F1,
    0x03045E, 0x03F361, 0x04F502, 0x04F5F1, 0x020702, 0x0507F1, 0x046703, 0x0567F1,
    0x680764, 0x68F564, 0x68F500, 0x68F5F1, 0x670600, 0x6807F1, 0x686704, 0x6867F1,
  ]),
};

/** Default CPC palette (measured Gate Array). Kept as the fallback for code
 *  paths that don't track the selected colour map (debug/OCR defaults, tests). */
export const CPC_PALETTE: Uint32Array = CPC_PALETTES['gate-array'];
