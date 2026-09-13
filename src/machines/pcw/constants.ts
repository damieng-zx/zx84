/**
 * Amstrad PCW constants — geometry, clocks, port numbers and bit layouts.
 *
 * Sources: the Amstrad PCW Hardware Reference (systemed.net/pcw/hardware.html,
 * compiled by CP Software, John Elliott, Jacob Nevins and Cliff Lawson) and
 * Jacob Nevins' PCW I/O port notes. Where the two disagree, or where the prose
 * is self-contradictory, the resolution is written out at the point of use
 * rather than left implicit — see `PCW_ROLLER_*` below and `asic.ts`.
 */

// ── Geometry ────────────────────────────────────────────────────────────────

/** Active display: 720x256 pixels = 90x32 characters on a 50Hz machine. */
export const PCW_DISPLAY_WIDTH = 720;
export const PCW_DISPLAY_HEIGHT = 256;

/** Border around the active area. The PCW has no programmable border colour —
 *  this is the black surround the monitor shows, and it is what port &F6's
 *  vertical-position adjustment slides the picture around inside. */
export const PCW_BORDER_LEFT = 24;
export const PCW_BORDER_TOP = 16;

export const PCW_SCREEN_WIDTH = PCW_DISPLAY_WIDTH + PCW_BORDER_LEFT * 2;   // 768
export const PCW_SCREEN_HEIGHT = PCW_DISPLAY_HEIGHT + PCW_BORDER_TOP * 2;  // 288

// ── Clocks and frame timing ─────────────────────────────────────────────────

/**
 * Effective CPU clock. The Z80A is fed 4MHz but the gate array steals memory
 * cycles for the display, and the reference states the resulting speed plainly:
 * "The PCW's clock speed is 3.4MHz, slowed down from a 4MHz CPU."
 *
 * Modelling the loss as a lower flat clock rather than per-access contention is
 * deliberate for now: it gets total work per frame right, which is what the
 * BIOS's timing loops care about. True contention only affects blocks 0-7 and
 * would need the raster position, like the SAM's quantiser.
 */
export const PCW_CPU_CLOCK = 3_400_000;

/** PAL field: 312 lines of 64us. 3.4MHz / 50Hz / 312 = 217.9 T-states/line. */
export const PCW_LINES_PER_FRAME = 312;
export const PCW_T_PER_LINE = 218;
export const PCW_T_PER_FRAME = PCW_T_PER_LINE * PCW_LINES_PER_FRAME; // 68016

/**
 * Interrupt cadence: "Interrupts occur 300 times a second, or 6 times per
 * frame, at 2 scan lines into frame flyback and every 52 lines thereafter."
 *
 * Frame flyback begins at line 256 (the first line after the active area), so
 * the first interrupt of a field is at line 258 and they repeat every 52 lines,
 * wrapping: 258, 310, 50, 102, 154, 206.
 */
export const PCW_INT_LINE_SPACING = 52;
export const PCW_FIRST_INT_LINE = PCW_DISPLAY_HEIGHT + 2; // 258
export const PCW_INTS_PER_FRAME = PCW_LINES_PER_FRAME / PCW_INT_LINE_SPACING; // 6

// ── Memory ──────────────────────────────────────────────────────────────────

/** One paging block: the PCW pages 16K at a time, four blocks to the 64K map. */
export const PCW_BLOCK_SIZE = 0x4000;
/** 16 blocks = 256K (8256), 32 = 512K (8512 / 9512). */
export const PCW_BLOCKS_256K = 16;
export const PCW_BLOCKS_512K = 32;

/**
 * Reset paging: "Block 80h at 0F0h, Block 81h at 0F1h, Block 82h at 0F2h,
 * Block 83h at 0F3h" — i.e. blocks 0-3 in order, each with bit 7 set to select
 * one block for both reads and writes.
 */
export const PCW_RESET_BLOCKS = [0x80, 0x81, 0x82, 0x83] as const;

/** Bit 7 of a &F0-&F3 write: one block for both reads and writes. */
export const PCW_BANK_SINGLE = 0x80;
/** Block number field when PCW_BANK_SINGLE is set (0-127 = up to 2MB). */
export const PCW_BANK_BLOCK_MASK = 0x7F;
/** Split mode (bit 7 clear): write block in b0-2, read block in b4-6. */
export const PCW_BANK_WRITE_MASK = 0x07;
export const PCW_BANK_READ_SHIFT = 4;

/** The gate array DMAs the keyboard into the last 16 bytes of block 3. */
export const PCW_KEYBOARD_BLOCK = 3;
export const PCW_KEYBOARD_OFFSET = 0x3FF0;
export const PCW_KEYBOARD_BYTES = 16;

// ── Ports ───────────────────────────────────────────────────────────────────

/**
 * The uPD765A answers the whole of &00-&7F: Z80 A7 is the chip select, so any
 * port with A7 low reaches it, and A0 picks the register. CP/M uses &00/&01.
 */
export const PCW_FDC_SELECT_MASK = 0x80;
export const PCW_FDC_REGISTER_BIT = 0x01;

/**
 * Scan lines the controller is given to answer a command before its interrupt
 * line is allowed to rise — 16 lines, about a millisecond.
 *
 * See `UPD765A.intResponseTicks` for why an instant answer wedges the CP/M
 * Plus boot. A millisecond is two orders of magnitude more than the ~26us
 * window that has to be covered, and still far less than the time any real
 * command takes (Read ID alone waits up to a revolution, 200ms), so it can
 * never make software wait longer than the hardware would. It costs nothing in
 * throughput either: the BIOS only notices an interrupt on a 300Hz tick, so the
 * 3.3ms between ticks sets the pace whatever this is.
 */
export const PCW_FDC_INT_RESPONSE_LINES = 16;

export const PORT_BANK0 = 0xF0;    // block at 0000
export const PORT_BANK1 = 0xF1;    // block at 4000
export const PORT_BANK2 = 0xF2;    // block at 8000
export const PORT_BANK3 = 0xF3;    // block at C000
export const PORT_MEMCTL = 0xF4;   // out: read-follows-write; in: status, clears counter
export const PORT_ROLLER = 0xF5;   // out: roller RAM base
export const PORT_VERTICAL = 0xF6; // out: vertical screen position
export const PORT_VIDEO = 0xF7;    // out: screen enable / reverse video
export const PORT_SYSTEM = 0xF8;   // out: command; in: status
export const PORT_PRINTER_DATA = 0xFC;
export const PORT_PRINTER_CTRL = 0xFD;

// ── Port &F8 out: a command number, not a bit field ─────────────────────────

/** "0 end bootstrap, 1 reboot, 2/3/4 connect FDC to NMI/standard interrupts/
 *  neither, 5/6 set/clear FDC terminal count, 7/8 screen on/off, 9/10 disc
 *  motor on/off, 11/12 beep on/off". */
export const enum PcwCommand {
  EndBootstrap = 0,
  Reboot = 1,
  FdcToNmi = 2,
  FdcToInt = 3,
  FdcToNeither = 4,
  SetTerminalCount = 5,
  ClearTerminalCount = 6,
  ScreenOn = 7,
  ScreenOff = 8,
  MotorOn = 9,
  MotorOff = 10,
  BeepOn = 11,
  BeepOff = 12,
}

// ── Port &F8 / &F4 in: system status ────────────────────────────────────────

/** b6: set during line flyback; set on two successive reads = frame flyback. */
export const PCW_STATUS_FLYBACK = 0x40;
/** b5: uPD765A interrupt line. */
export const PCW_STATUS_FDC_INT = 0x20;
/** b4: set on a 32-line (i.e. 50Hz) screen. */
export const PCW_STATUS_32_LINE = 0x10;
/** b3-0: the 300Hz interrupt counter. Reading &F4 resets it; &F8 does not. */
export const PCW_STATUS_COUNT_MASK = 0x0F;

// ── Port &F7: screen control ────────────────────────────────────────────────

/** b6 enables the screen, b7 reverses it. Jacob Nevins' notes give the four
 *  combinations as ink/paper intensities, which is the model `asic.ts` uses:
 *  (b7,b6) = 00 all black, 01 normal, 10 all white, 11 inverse. */
export const PCW_VIDEO_ENABLE = 0x40;
export const PCW_VIDEO_REVERSE = 0x80;

// ── Port &F5: roller RAM base ───────────────────────────────────────────────

/**
 * b7-5 select a 16K block; b4-0 give the offset within it in 512-byte units.
 *
 * The reference says "b4-1: address / 512", but that cannot be right: under
 * CP/M the roller RAM lives at &3600 in block 2 and the BIOS writes &5B.
 * &5B >> 5 = 2 (block 2, as documented), and &5B & &1F = 27, and 27 * 512 =
 * &3600 — exactly the documented address. Taking b4-1 instead yields 13 * 512
 * = &1A00, which is not where the roller RAM is. So the field is b4-0.
 */
export const PCW_ROLLER_BLOCK_SHIFT = 5;
export const PCW_ROLLER_OFFSET_MASK = 0x1F;
export const PCW_ROLLER_OFFSET_UNIT = 512;
/** 256 entries of 2 bytes: one per scan line. */
export const PCW_ROLLER_ENTRIES = 256;

/**
 * Bytes per scan line, and the stride between them.
 *
 * "Each line is 720, not 90 bytes long. This is because the PCW takes every
 * eighth byte starting at the address pointed to by the roller RAM" — the
 * screen is stored as 8-byte character cells, so consecutive bytes across a
 * line sit 8 apart and the low 3 bits of the roller entry pick the pixel row
 * within the cell.
 */
export const PCW_BYTES_PER_LINE = PCW_DISPLAY_WIDTH / 8; // 90
export const PCW_LINE_BYTE_STRIDE = 8;

/** Physical address space the video fetch walks: 8 blocks of 16K = 128K. */
export const PCW_VIDEO_ADDRESS_MASK = 0x1FFFF;

// ── Colours (RGBA little-endian, as the renderers expect) ───────────────────

/** The PCW's green phosphor monitor, and the paper it draws on. */
export const PCW_GREEN_INK = 0xFF64F864 | 0;
export const PCW_GREEN_PAPER = 0xFF0C1C0C | 0;
/** The 9512's paper-white monitor. */
export const PCW_WHITE_INK = 0xFFF0F0F0 | 0;
export const PCW_WHITE_PAPER = 0xFF101010 | 0;

/** Selectable phosphor colours, keyed by the `pcw-phosphor` setting. */
export const PCW_PHOSPHORS: Record<string, { ink: number; paper: number }> = {
  green: { ink: PCW_GREEN_INK, paper: PCW_GREEN_PAPER },
  white: { ink: PCW_WHITE_INK, paper: PCW_WHITE_PAPER },
};

// ── Bootstrap ───────────────────────────────────────────────────────────────

/** Boot sector: cylinder 0, head 0, sector 1, loaded to &F000 and entered at
 *  &F010 once its checksum verifies. */
export const PCW_BOOT_LOAD_ADDR = 0xF000;
export const PCW_BOOT_ENTRY_ADDR = 0xF010;
export const PCW_BOOT_SECTOR_SIZE = 512;
