/**
 * Commodore 64 timing and frame geometry: the VIC-II board's, shared with the
 * Commodore 128 (see `shared/cbm/vic-ii-board.ts` for the numbers and what
 * they mean). The names here are the C64's own.
 */

import {
  VIC_BOARD_ACTIVE_HEIGHT, VIC_BOARD_ACTIVE_WIDTH, VIC_BOARD_BORDER_LEFT, VIC_BOARD_BORDER_TOP,
  VIC_BOARD_FIRST_LINE, VIC_BOARD_FIRST_X, VIC_BOARD_SCREEN_HEIGHT, VIC_BOARD_SCREEN_WIDTH,
  VIC_NTSC_CPU_CLOCK, VIC_PAL_CPU_CLOCK, VIC_PAL_CYCLES_PER_FRAME, VIC_PAL_CYCLES_PER_LINE,
  VIC_PAL_LINES_PER_FRAME, vicBoardTiming, type VicBoardTiming,
} from '@/machines/shared/cbm/vic-ii-board.ts';

/** CPU (phi2) clock of the PAL C64: 17.734475 MHz / 18. */
export const C64_CPU_CLOCK = VIC_PAL_CPU_CLOCK;
export const C64_CYCLES_PER_LINE = VIC_PAL_CYCLES_PER_LINE;
export const C64_LINES_PER_FRAME = VIC_PAL_LINES_PER_FRAME;
export const C64_CYCLES_PER_FRAME = VIC_PAL_CYCLES_PER_FRAME;

export const C64_FIRST_X = VIC_BOARD_FIRST_X;
export const C64_FIRST_LINE = VIC_BOARD_FIRST_LINE;
export const C64_SCREEN_WIDTH = VIC_BOARD_SCREEN_WIDTH;
export const C64_SCREEN_HEIGHT = VIC_BOARD_SCREEN_HEIGHT;
export const C64_ACTIVE_WIDTH = VIC_BOARD_ACTIVE_WIDTH;
export const C64_ACTIVE_HEIGHT = VIC_BOARD_ACTIVE_HEIGHT;
/** Where the display window starts in the frame buffer. */
export const C64_BORDER_LEFT = VIC_BOARD_BORDER_LEFT;
export const C64_BORDER_TOP = VIC_BOARD_BORDER_TOP;

/** Everything about the machine that follows the TV standard. */
export type C64Timing = VicBoardTiming;

export const c64Timing: (ntsc: boolean) => C64Timing = vicBoardTiming;

/** CPU (phi2) clock of the NTSC C64: 14.31818 MHz / 14. */
export const C64_NTSC_CPU_CLOCK = VIC_NTSC_CPU_CLOCK;

/** ROM image sizes: BASIC and KERNAL are 8K each, the character ROM 4K. */
export const C64_BASIC_SIZE = 0x2000;
export const C64_KERNAL_SIZE = 0x2000;
export const C64_CHARGEN_SIZE = 0x1000;
/** The system ROM as the ROM host serves it: BASIC, KERNAL, then characters. */
export const C64_ROM_SIZE = C64_BASIC_SIZE + C64_KERNAL_SIZE + C64_CHARGEN_SIZE;
