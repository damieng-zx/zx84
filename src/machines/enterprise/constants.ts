/**
 * Enterprise 64/128 hardware constants.
 *
 * A 1985 British home computer: a Z80A at 4MHz between two custom chips —
 * Nick, which generates the picture from a list of per-line mode records, and
 * Dave, which pages a 4MB address space into the Z80's 64K, makes the sound
 * and owns the interrupts. Facts here were cross-checked between ep128emu
 * (istvan-v/ep128emu, `nick.cpp`/`dave.cpp`) and Clock Signal
 * (TomHarte/CLK, `Machines/Enterprise`); neither is copied.
 */

/** Z80A clock. Dave's 8MHz input divided by two. */
/** Floppy drives the EXDOS card takes (the WD1770's four select lines). */
export const EP_MAX_DRIVES = 4;

export const EP_CPU_CLOCK = 4_000_000;

/**
 * Nick line timing. A line is 57 slots of 16 Nick clocks (912 clocks,
 * one 64µs PAL line), which is 256 Z80 T-states. The picture's shape is
 * whatever the line parameter table says, but EXOS's table is the standard
 * 312-line PAL frame, so that is what one emulated frame runs.
 */
export const NICK_SLOTS_PER_LINE = 57;
export const EP_T_PER_LINE = 256;
export const EP_LINES_PER_FRAME = 312;
export const EP_T_PER_FRAME = EP_T_PER_LINE * EP_LINES_PER_FRAME;

/** Nick clocks per Z80 T-state (912 / 256). */
export const NICK_CLOCKS_PER_T = 912 / EP_T_PER_LINE;

/**
 * The picture Nick can put out: slots 7 to 54 are its display area (the slots
 * before carry the line parameter fetch, the ones after the end of line), at
 * 16 pixels a slot in its finest resolution.
 */
export const NICK_FIRST_VISIBLE_SLOT = 7;
export const NICK_VISIBLE_SLOTS = 48;
export const EP_FRAME_WIDTH = NICK_VISIBLE_SLOTS * 16;   // 768
/** Lines shown, counted from the end of the vertical sync block. */
export const EP_FRAME_HEIGHT = 288;
/** Lines after the end of vertical sync before the first displayed one. */
export const EP_VSYNC_TO_FIRST_LINE = 18;

/**
 * The area EXOS draws its 40-column screen into, for the transcribe overlay
 * and border cropping: margins 0x0B to 0x33 (40 slots) on EXOS's own line
 * parameter table, 28 rows of nine-line characters, which start 20 lines
 * into the displayed frame.
 */
export const EP_ACTIVE_LEFT = (0x0B - NICK_FIRST_VISIBLE_SLOT) * 16;
export const EP_ACTIVE_WIDTH = (0x33 - 0x0B) * 16;
export const EP_ACTIVE_TOP = 20;
export const EP_ACTIVE_HEIGHT = 28 * 9;

/** Memory: 256 segments of 16K, the top four of which are Nick's video RAM. */
export const EP_SEGMENT_SIZE = 0x4000;
export const EP_SEGMENTS = 256;
export const EP_VIDEO_FIRST_SEGMENT = 0xFC;

/**
 * Where each ROM sits in the segment space. EXOS is the internal ROM at
 * segment 0 (32K for 2.0/2.1, 64K for 2.3); the cartridge slot is segments 4
 * to 7, and BASIC is a cartridge. EXDOS and the emulator's FILE: device go in
 * slots EXOS scans for extension ROMs, at the segments ep128emu's default
 * configurations use.
 */
export const SEG_EXOS = 0x00;
export const SEG_CARTRIDGE = 0x04;
export const SEG_HOSTFS = 0x10;
export const SEG_EXDOS = 0x20;
/** Four extension-ROM sockets of up to 32K each (EPDOS, ZozoTools, …), in
 *  segments EXOS also scans: 0x30, 0x32, 0x34, 0x36. */
export const SEG_EXTENSION = 0x30;
export const EXTENSION_SOCKETS = 4;
export const EXTENSION_MAX_SIZE = 2 * EP_SEGMENT_SIZE;

/** Size of the EXOS image slot (four segments); shorter ROMs leave the rest
 *  unpopulated. */
export const EXOS_MAX_SIZE = 4 * EP_SEGMENT_SIZE;
export const CARTRIDGE_MAX_SIZE = 4 * EP_SEGMENT_SIZE;
export const EXDOS_MAX_SIZE = 2 * EP_SEGMENT_SIZE;

/**
 * I/O ports. Nick decodes 0x80-0x8F (four registers, mirrored), Dave 0xA0-0xBF,
 * and the EXDOS card 0x10-0x1F (the WD1770 at 0x10-0x13 mirrored to 0x17, its
 * control/status latch at 0x18-0x1F).
 */
export const PORT_NICK_BASE = 0x80;
export const PORT_DAVE_SOUND = 0xA0;
export const PORT_PAGE0 = 0xB0;
export const PORT_INTERRUPT = 0xB4;
export const PORT_KEYBOARD = 0xB5;
export const PORT_JOYSTICK = 0xB6;
export const PORT_SERIAL = 0xB7;
export const PORT_SYSCONFIG = 0xBF;
export const PORT_EXDOS_FDC = 0x10;
export const PORT_EXDOS_CONTROL = 0x18;
