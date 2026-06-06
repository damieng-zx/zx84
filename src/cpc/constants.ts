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
 * Gate-Array hardware palette: index = the 5-bit value written by the colour
 * command (0–31), value = packed ABGR (0xAABBGGRR — the word order the canvas /
 * WebGL renderers consume, matching `PALETTES` in cores/ula.ts).
 *
 * Built from the documented (R,G,B) intensity percentages (0/50/100), with 50%
 * mapped to 0x80. Source: CPCTech Gate-Array colour conversion table.
 */
export const CPC_PALETTE: Uint32Array = (() => {
  // (R%,G%,B%) per hardware value 0–31, as 0 / 50 / 100.
  const pct: ReadonlyArray<readonly [number, number, number]> = [
    [50, 50, 50], [50, 50, 50], [0, 100, 50], [100, 100, 50],
    [0, 0, 50], [100, 0, 50], [0, 50, 50], [100, 50, 50],
    [100, 0, 50], [100, 100, 50], [100, 100, 0], [100, 100, 100],
    [100, 0, 0], [100, 0, 100], [100, 50, 0], [100, 50, 100],
    [0, 0, 50], [0, 100, 50], [0, 100, 0], [0, 100, 100],
    [0, 0, 0], [0, 0, 100], [0, 50, 0], [0, 50, 100],
    [50, 0, 50], [50, 100, 50], [50, 100, 0], [50, 100, 100],
    [50, 0, 0], [50, 0, 100], [50, 50, 0], [50, 50, 100],
  ];
  const level = (p: number): number => (p === 0 ? 0 : p === 50 ? 0x80 : 0xFF);
  const out = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    const [r, g, b] = pct[i];
    out[i] = ((0xFF000000 | (level(b) << 16) | (level(g) << 8) | level(r)) >>> 0);
  }
  return out;
})();
