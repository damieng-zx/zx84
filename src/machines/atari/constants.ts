/**
 * Atari 400/800 timing, geometry and colour constants.
 *
 * The 8-bit Atari family is region-locked hardware: the CPU clock, the number
 * of scanlines and the colour generation all follow the TV standard. The 400
 * and 800 were sold in both territories and the same OS revision image ran on
 * both (the machine tells PAL from NTSC through GTIA, not through a different
 * ROM), so the region is a model property rather than a ROM property.
 *
 * NTSC: 1.7897725 MHz 6502, 262 scanlines of 114 cycles.
 * PAL:  1.773447  MHz 6502, 312 scanlines of 114 cycles.
 *
 * Both standards display a 240-line picture; the extra PAL lines are vertical
 * blanking. ANTIC steals cycles from the CPU for refresh, display-list,
 * playfield and player/missile DMA, so the CPU's *effective* clock is lower
 * than the crystal figure above (about 1.19 MHz for a full 40-column screen).
 */

export interface AtariTiming {
  /** 6502 crystal clock in Hz. */
  readonly clockHz: number;
  /** Total scanlines in one frame, including vertical blanking. */
  readonly linesPerFrame: number;
  /** CPU cycles in one scanline. */
  readonly cyclesPerLine: number;
  /** Nominal CPU cycles per frame, before ANTIC's DMA steals. */
  readonly tStatesPerFrame: number;
  /** Picture lines actually shown (the remaining lines are VBLANK). */
  readonly displayLines: number;
  readonly pal: boolean;
}

export const ATARI_CYCLES_PER_LINE = 114;
export const ATARI_NTSC_CLOCK = 1_789_772;
export const ATARI_PAL_CLOCK = 1_773_447;
export const ATARI_NTSC_LINES = 262;
export const ATARI_PAL_LINES = 312;
/** Both regions show the same 240-line field; PAL only widens VBLANK. */
export const ATARI_DISPLAY_LINES = 240;

export function atariTiming(pal: boolean): AtariTiming {
  const linesPerFrame = pal ? ATARI_PAL_LINES : ATARI_NTSC_LINES;
  return {
    clockHz: pal ? ATARI_PAL_CLOCK : ATARI_NTSC_CLOCK,
    linesPerFrame,
    cyclesPerLine: ATARI_CYCLES_PER_LINE,
    tStatesPerFrame: linesPerFrame * ATARI_CYCLES_PER_LINE,
    displayLines: ATARI_DISPLAY_LINES,
    pal,
  };
}

/**
 * Frame-buffer geometry. A normal (320-pixel) playfield sits in the middle of
 * a 336x240 buffer: 8 pixels of horizontal and 24 lines of vertical border,
 * which is the overscan a real TV shows around a GRAPHICS 0 screen. The 160
 * pixel playfields (ANTIC modes 6, 7, 9, A, B, C) are drawn double-width into
 * the same 320-pixel window, exactly as the hardware does.
 *
 * The playfield's first colour clock is 48; players and missiles are
 * positioned in the same colour-clock space, so this constant is what maps
 * HPOSP/HPOSM to a buffer X.
 */
export const ATARI_SCREEN_WIDTH = 336;
export const ATARI_SCREEN_HEIGHT = 240;
export const ATARI_ACTIVE_WIDTH = 320;
export const ATARI_ACTIVE_HEIGHT = 192;
export const ATARI_BORDER_LEFT = 8;
export const ATARI_BORDER_TOP = 24;
export const ATARI_PLAYFIELD_LEFT_CLOCK = 48;
/** 320x192 shown as 4:3 television: pixels are 0.8 as wide as they are tall. */
export const ATARI_PIXEL_ASPECT_X = 0.8;
