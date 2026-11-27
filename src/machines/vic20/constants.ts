/**
 * Commodore VIC-20 timing and frame geometry.
 *
 * The VIC runs the machine: its pixel clock divided by four is the CPU's
 * clock, so one CPU cycle is four pixels, and a character (eight pixels wide)
 * takes two cycles. The PAL chip (6561) has 71 cycles a line and 312 lines;
 * the NTSC chip (6560) 65 cycles and 261 lines (not interlaced).
 *
 * The horizontal origin register ($9000) counts in cycles (four pixels) from
 * the start of the line and the vertical origin ($9001) in pairs of lines from
 * the top of the frame; the KERNAL sets 12 and 38 on PAL and 5 and 25 on
 * NTSC. The visible window below is placed around the text area those
 * defaults give (22 columns by 23 rows), with the border a TV shows round it.
 * Where the chip's blanking falls exactly has not been measured here.
 *
 * Every VIC pixel is two pixels of the frame buffer across, so the buffer's
 * pixels are about as wide as the C64's and the two machines show at the same
 * scale.
 */

/** CPU clock of the PAL VIC-20: 4.433619 MHz / 4. */
export const VIC20_PAL_CLOCK = 1_108_405;
/** CPU clock of the NTSC VIC-20: 14.31818 MHz / 14. */
export const VIC20_NTSC_CLOCK = 1_022_727;

/** Frame-buffer pixels per VIC pixel, across. */
export const VIC20_PIXEL_DOUBLE = 2;

/** Default text area the KERNAL sets up: 22 columns of 8 pixels, 23 rows of 8 lines. */
export const VIC20_DEFAULT_COLUMNS = 22;
export const VIC20_DEFAULT_ROWS = 23;

export interface Vic20Timing {
  readonly ntsc: boolean;
  /** CPU clock in Hz. */
  readonly clockHz: number;
  readonly cyclesPerLine: number;
  readonly linesPerFrame: number;
  readonly cyclesPerFrame: number;
  /** First VIC pixel of the line in the frame buffer, and how many it holds. */
  readonly firstPixel: number;
  readonly visiblePixels: number;
  /** First raster line in the frame buffer, and how many it holds. */
  readonly firstLine: number;
  readonly visibleLines: number;
  /** The KERNAL's horizontal and vertical origins (in cycles and line pairs). */
  readonly defaultHOrigin: number;
  readonly defaultVOrigin: number;
}

export const VIC20_PAL_TIMING: Vic20Timing = {
  ntsc: false,
  clockHz: VIC20_PAL_CLOCK,
  cyclesPerLine: 71,
  linesPerFrame: 312,
  cyclesPerFrame: 71 * 312,
  // The text starts 48 pixels into the line (origin 12) and is 176 wide:
  // 28 pixels of border either side.
  firstPixel: 20,
  visiblePixels: 232,
  // The text starts on line 76 (origin 38) and is 184 lines high: 48 lines of
  // border above and 52 below, to the end of the frame.
  firstLine: 28,
  visibleLines: 284,
  defaultHOrigin: 12,
  defaultVOrigin: 38,
};

export const VIC20_NTSC_TIMING: Vic20Timing = {
  ntsc: true,
  clockHz: VIC20_NTSC_CLOCK,
  cyclesPerLine: 65,
  linesPerFrame: 261,
  cyclesPerFrame: 65 * 261,
  // The text starts 20 pixels in (origin 5): 20 pixels of border either side.
  firstPixel: 0,
  visiblePixels: 216,
  // The text starts on line 50 (origin 25): 24 lines of border above and below.
  firstLine: 26,
  visibleLines: 232,
  defaultHOrigin: 5,
  defaultVOrigin: 25,
};

export function vic20Timing(ntsc: boolean): Vic20Timing {
  return ntsc ? VIC20_NTSC_TIMING : VIC20_PAL_TIMING;
}

/** Frame-buffer geometry for a timing: the whole visible window, and where
 *  the KERNAL's default text area sits in it. */
export function vic20Screen(t: Vic20Timing): {
  width: number; height: number; activeWidth: number; activeHeight: number;
  borderLeft: number; borderTop: number;
} {
  return {
    width: t.visiblePixels * VIC20_PIXEL_DOUBLE,
    height: t.visibleLines,
    activeWidth: VIC20_DEFAULT_COLUMNS * 8 * VIC20_PIXEL_DOUBLE,
    activeHeight: VIC20_DEFAULT_ROWS * 8,
    borderLeft: (t.defaultHOrigin * 4 - t.firstPixel) * VIC20_PIXEL_DOUBLE,
    borderTop: t.defaultVOrigin * 2 - t.firstLine,
  };
}

/** Buffer pixels' width against their height: the PAL VIC's pixel is 1.78 of
 *  the C64's (4.43 against 7.88 MHz) and the NTSC one's twice (4.09 against
 *  8.18 MHz), each drawn two buffer pixels wide; the C64 shows its pixels square. */
export function vic20PixelAspect(ntsc: boolean): number {
  return ntsc ? 1 : (7_881_984 / 4_433_619) / VIC20_PIXEL_DOUBLE;
}

/** ROM image sizes: BASIC and KERNAL are 8K each, the character ROM 4K. */
export const VIC20_BASIC_SIZE = 0x2000;
export const VIC20_KERNAL_SIZE = 0x2000;
export const VIC20_CHARGEN_SIZE = 0x1000;
/** The system ROM as the ROM host serves it: BASIC, KERNAL, then characters. */
export const VIC20_ROM_SIZE = VIC20_BASIC_SIZE + VIC20_KERNAL_SIZE + VIC20_CHARGEN_SIZE;
