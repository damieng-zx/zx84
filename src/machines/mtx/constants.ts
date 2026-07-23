/** Memotech MTX master/CPU clock. */
export const MTX_CPU_CLOCK = 4_000_000;
/** PAL field rate and line geometry used by the TMS9929A. */
export const MTX_LINES_PER_FRAME = 313;
export const MTX_TSTATES_PER_FRAME = MTX_CPU_CLOCK / 50;
export const MTX_ACTIVE_LINES = 192;

/** Full-border presentation geometry around the 256x192 VDP aperture. */
export const MTX_SCREEN_WIDTH = 320;
export const MTX_SCREEN_HEIGHT = 240;
export const MTX_BORDER_LEFT = 32;
export const MTX_BORDER_TOP = 24;
