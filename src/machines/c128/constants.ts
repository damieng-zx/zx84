/**
 * Commodore 128 constants: the ROM images, the frame, the clock.
 *
 * The VIC-IIe (8566 on PAL, 8564 on NTSC) runs the same lines and cycles as
 * the C64's VIC-II, so the timing and the frame geometry are the board's
 * (`shared/cbm/vic-ii-board.ts`). The 8502 runs at 1 MHz (phi2) here; its
 * 2 MHz mode is a later phase.
 */

export {
  vicBoardTiming as c128Timing,
  VIC_BOARD_ACTIVE_HEIGHT as C128_ACTIVE_HEIGHT,
  VIC_BOARD_ACTIVE_WIDTH as C128_ACTIVE_WIDTH,
  VIC_BOARD_BORDER_LEFT as C128_BORDER_LEFT,
  VIC_BOARD_SCREEN_WIDTH as C128_SCREEN_WIDTH,
  type VicBoardTiming as C128Timing,
} from '@/machines/shared/cbm/vic-ii-board.ts';

/** The ROM images, one per socket: BASIC 7.0 low ($4000-$7FFF) and high
 *  ($8000-$BFFF), the system ROM ($C000-$FFFF: the screen editor, the Z80
 *  BIOS under the I/O page, the KERNAL), and the character ROM (the C64's
 *  4K set then the 128's own). */
export const C128_BASIC_LO_SIZE = 0x4000;
export const C128_BASIC_HI_SIZE = 0x4000;
export const C128_KERNAL_SIZE = 0x4000;
export const C128_CHARGEN_SIZE = 0x2000;

/** Where the Z80 BIOS is in the system ROM: the 4K under the I/O page, which
 *  the Z80 sees at its $0000-$0FFF. */
export const C128_Z80_BIOS_OFFSET = 0x1000;
export const C128_Z80_BIOS_SIZE = 0x1000;
/** The character ROM's 128-mode set is its second 4K. */
export const C128_CHARGEN_128_OFFSET = 0x1000;
