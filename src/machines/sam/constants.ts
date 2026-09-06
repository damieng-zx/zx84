/**
 * SAM Coupé hardware constants.
 *
 * All timing derives from the 24 MHz master clock:
 *   - Z80B CLK    = 24 / 4 = 6 MHz
 *   - SAA1099 CLK = 24 / 3 = 8 MHz
 *   - One character cell = 8 T-states; 48 cells per line = 384 T-states;
 *     312 lines per PAL field = 119 808 T-states → 50.08 Hz.
 *
 * Port numbers and bit masks are transcribed from SimCoupe's `Base/SAMIO.h`
 * and the SAM Coupé Technical Manual v3.0 — not reconstructed. Where a value
 * is easy to get backwards (the CLUT index, the SAA address/data split, the
 * active-low STATUS bits) the comment says so.
 */

/** Z80B clock (Hz). */
export const SAM_CPU_CLOCK = 6_000_000;

/** SAA1099 clock (Hz) — 24 MHz / 3. */
export const SAM_SAA_CLOCK = 8_000_000;

/** T-states per character cell (the ASIC's fundamental unit of video time). */
export const SAM_T_PER_CELL = 8;

/** Character cells per scanline, including both borders and blanking. */
export const SAM_CELLS_PER_LINE = 48;

/** T-states per scanline (48 × 8). */
export const SAM_T_PER_LINE = SAM_CELLS_PER_LINE * SAM_T_PER_CELL; // 384

/** PAL field length in scanlines. */
export const SAM_LINES_PER_FRAME = 312;

/** Nominal T-states per video frame (384 × 312 = 119 808 → 50.08 Hz). */
export const SAM_T_PER_FRAME = SAM_T_PER_LINE * SAM_LINES_PER_FRAME;

// ── Frame-buffer geometry ───────────────────────────────────────────────────
//
// The buffer is sampled at mode 3's horizontal resolution (512 px across the
// 256-pixel active window), so one character cell always spans 16 buffer
// pixels regardless of screen mode — exactly the trick the CPC's Gate Array
// uses for its 16 pixel-clock character. Modes 1/2/4 double each logical
// pixel; mode 3 is 1:1. `pixelAspectX: 0.5` in the descriptor presents the
// 768×288 buffer as 384×288, which is exactly 4:3.

export const SAM_SCREEN_WIDTH = SAM_CELLS_PER_LINE * 16;   // 768
export const SAM_SCREEN_HEIGHT = 288;                      // 192 active + 48 + 48

/** Buffer pixels per character cell. */
export const SAM_CELL_PX = 16;

/** Active display area within the buffer. */
export const SAM_DISPLAY_WIDTH = 512;   // 256 logical px doubled, or 512 in mode 3
export const SAM_DISPLAY_HEIGHT = 192;

export const SAM_BORDER_LEFT = (SAM_SCREEN_WIDTH - SAM_DISPLAY_WIDTH) >> 1;   // 128
export const SAM_BORDER_TOP = (SAM_SCREEN_HEIGHT - SAM_DISPLAY_HEIGHT) >> 1;  // 48

/** First character cell of the active display window within a scanline. */
export const SAM_DISPLAY_FIRST_CELL = SAM_BORDER_LEFT / SAM_CELL_PX;          // 8
/** Character cells of active display (32 × 8 = 256 logical pixels). */
export const SAM_DISPLAY_CELLS = SAM_DISPLAY_WIDTH / SAM_CELL_PX;             // 32

/** Raster line of the first displayed scanline. Raster lines run 0..311; lines
 *  SAM_SCREEN_HEIGHT..311 are vertical blanking and are never drawn. */
export const SAM_DISPLAY_FIRST_LINE = SAM_BORDER_TOP;                         // 48
/** One past the last displayed raster line. */
export const SAM_DISPLAY_LAST_LINE = SAM_DISPLAY_FIRST_LINE + SAM_DISPLAY_HEIGHT; // 240

/**
 * T-states between the CPU's line boundary and the raster's.
 *
 * The ASIC's beam runs one side border behind the frame counter the CPU's
 * interrupts are measured against — SimCoupe calls this
 * `CPU_CYCLES_ASIC_TO_FRAME_OFFSET` and derives it from
 * `CPU_CYCLES_PER_SIDE_BORDER`, converting a CPU time to a raster position with
 * `(cycles - offset)`. It matters for every mid-line register write: without it
 * a palette change lands eight character cells too far right, which is exactly
 * how far the ROM's boot-screen colour bands used to overshoot into the right
 * border.
 */
export const SAM_ASIC_T_OFFSET = SAM_BORDER_LEFT / SAM_CELL_PX * SAM_T_PER_CELL; // 64

/** Cells between the CPU's line boundary and the raster's (the above, in cells). */
export const SAM_ASIC_CELL_OFFSET = SAM_ASIC_T_OFFSET / SAM_T_PER_CELL;          // 8

/**
 * T-state within a line at which the ASIC starts fetching display data.
 *
 * Two side borders' worth: the beam reaches the left edge of the display one
 * border after the raster line starts, and the raster itself starts one border
 * after the CPU's line boundary. Contention and the light-pen registers are
 * both measured from here, in CPU time.
 */
export const SAM_DISPLAY_FIRST_T = 2 * SAM_ASIC_T_OFFSET;                        // 128

/**
 * Lines between the frame interrupt and the first displayed line, and between
 * the last displayed line and the next frame interrupt.
 *
 * The frame interrupt is NOT the moment the display ends: SimCoupe's
 * `TOP_BORDER_LINES` / `BOTTOM_BORDER_LINES` put 52 lines after the display and
 * 68 before it. That split is load-bearing for the LINE register — see
 * `lineInterruptRaster` — because it decides which LINE values still have a
 * raster left to fire on before the next field re-arms them.
 */
export const SAM_TOP_BORDER_LINES = 68;
export const SAM_BOTTOM_BORDER_LINES =
  SAM_LINES_PER_FRAME - SAM_DISPLAY_HEIGHT - SAM_TOP_BORDER_LINES;             // 52

/**
 * How long the software library holds F9 down to boot a disk, in frames.
 *
 * The SAM's power-on RAM test runs for around two and a half seconds before
 * the ROM acts on the key, and a slow or empty drive can push that out, so the
 * ceiling is generous — it only matters when nothing boots at all.
 */
export const SAM_BOOT_KEY_FRAMES = 900;

/** Raster line on which the frame interrupt is raised: one top border before
 *  the display, which wraps round to the far side of the field. */
export const SAM_FRAME_INT_LINE =
  (SAM_DISPLAY_FIRST_LINE - SAM_TOP_BORDER_LINES + SAM_LINES_PER_FRAME)
  % SAM_LINES_PER_FRAME;                                                       // 292

/**
 * How long the ASIC holds /INT low, in T-states.
 *
 * The SAM's interrupt line is NOT cleared by a CPU acknowledge or by reading
 * the status port — the ASIC asserts it for a fixed period and then releases
 * it. That matters in both directions: a routine with interrupts disabled
 * across the whole window misses the interrupt entirely, and a handler that
 * re-enables interrupts inside the window is re-entered, exactly as on real
 * hardware.
 *
 * TODO(verify): 128 T-states (~21 µs at 6 MHz) is the working figure and is
 * the right order of magnitude, but it has not been checked against the SAM
 * Technical Manual or measured on hardware. Confirm before relying on it for
 * timing-critical software.
 */
export const SAM_INT_ACTIVE_T = 128;

// ── Ports (low byte; the high byte matters only where noted) ────────────────

/** Kempston joystick (read). */
export const PORT_KEMPSTON = 0x1F;
/** External megabyte page registers. */
export const PORT_LEPR = 0x80;
export const PORT_HEPR = 0x81;
/** First internal floppy drive: 0xE0–0xE7. */
export const PORT_FLOPPY1_BASE = 0xE0;
/** Second internal floppy drive: 0xF0–0xF7. */
export const PORT_FLOPPY2_BASE = 0xF0;
/**
 * CLUT write / light-pen read.
 *
 * IMPORTANT: the palette entry being written is selected by the port's HIGH
 * byte, not by a separate index register:
 *     `clut[(port >> 8) & 15] = value & 0x7F`
 * so `OUT (&03F8), A` writes entry 3. Getting this backwards is the single
 * easiest mistake to make here.
 */
export const PORT_CLUT = 0xF8;
/**
 * Reading 0xF8 gives a light-pen register instead, and *bit 8 of the port
 * address* picks which: 0x00F8 is LPEN (the beam's horizontal position),
 * 0x01F8 is HPEN (the display line it is on). Mask with `PEN_PORT_MASK` — the
 * rest of the high byte is the CLUT index and must be ignored on a read.
 */
export const PORT_LPEN = 0x00F8;
export const PORT_HPEN = 0x01F8;
export const PEN_PORT_MASK = 0x01FF;
/** LPEN bit 1: MIDI transmit status. Nothing here drives it. */
export const LPEN_TXFMST = 0x02;
/** STATUS (read) / LINE interrupt register (write). */
export const PORT_STATUS = 0xF9;
/** Low memory page register. */
export const PORT_LMPR = 0xFA;
/** High memory page register. */
export const PORT_HMPR = 0xFB;
/** Video memory page register. */
export const PORT_VMPR = 0xFC;
/** MIDI / serial. Decoded but not implemented. */
export const PORT_MIDI = 0xFD;
/** Keyboard (read) / border + beeper (write) — Spectrum-compatible. */
export const PORT_BORDER = 0xFE;
/**
 * SAA1099 data (write) and the ASIC attribute byte (read).
 *
 * IMPORTANT: the SAA's A0 pin is wired to Z80 A8, so the full 16-bit port
 * address selects which register file is addressed:
 *     0x00FF = DATA, 0x01FF = ADDRESS.
 * Both share the same low byte.
 */
export const PORT_SAA_LOW = 0xFF;
export const PORT_SAA_DATA = 0x00FF;
export const PORT_SAA_ADDRESS = 0x01FF;

// ── LMPR (0xFA) ─────────────────────────────────────────────────────────────

/** Page selected into section A, and (page+1) into section B. */
export const LMPR_PAGE_MASK = 0x1F;
/** Set = ROM 0 is NOT paged over section A (i.e. RAM shows through). */
export const LMPR_ROM0_OFF = 0x20;
/** Set = ROM 1 is paged over section D. */
export const LMPR_ROM1 = 0x40;
/** Set = the low 32K is write-protected. */
export const LMPR_WPROT = 0x80;

// ── HMPR (0xFB) ─────────────────────────────────────────────────────────────

/** Page selected into section C, and (page+1) into section D. */
export const HMPR_PAGE_MASK = 0x1F;
/** Mode 3 border/"MD3COL" colour bits. */
export const HMPR_MD3COL_MASK = 0x60;
export const HMPR_MD3COL_SHIFT = 5;
/** Set = sections C/D come from the external megabyte interface. */
export const HMPR_MCNTRL = 0x80;

// ── VMPR (0xFC) ─────────────────────────────────────────────────────────────

export const VMPR_PAGE_MASK = 0x1F;
export const VMPR_MODE_MASK = 0x60;
export const VMPR_MODE_SHIFT = 5;
/**
 * Bit 7 of VMPR is not part of the register: on a READ it is the MIDI-receive
 * status, and it reads SET whenever no MIDI byte is waiting — which, with no
 * MIDI input emulated, is always.
 *
 * This is not cosmetic. SAMPaint's boot program checks the machine with
 * `IF IN 252<>254 THEN CALL 0` — read VMPR straight after `SCREEN 1: MODE 4`,
 * and reset the computer unless it reads 0xFE. Returning the written 0x7E
 * makes the program reset itself the moment it loads, which looks for all the
 * world like a crash. SimCoupe ORs the same bit in (`VMPR_RXMIDI_MASK`).
 */
export const VMPR_RXMIDI = 0x80;

// ── STATUS / LINE (0xF9) ────────────────────────────────────────────────────
//
// The status bits are ACTIVE LOW: a bit reads 0 while that interrupt is
// pending, and 1 while it is not. `STATUS_IDLE` is the reset state.

export const STATUS_INT_LINE = 0x01;
export const STATUS_INT_MOUSE = 0x02;
export const STATUS_INT_MIDIIN = 0x04;
export const STATUS_INT_FRAME = 0x08;
export const STATUS_INT_MIDIOUT = 0x10;
/** All five interrupt bits high = nothing pending. */
export const STATUS_IDLE = 0x1F;
/** Keyboard bits returned in the top three bits of an `IN 0xF9`. */
export const STATUS_KEY_MASK = 0xE0;

// ── BORDER / KEYBOARD (0xFE) ────────────────────────────────────────────────

/** Border colour on a write: bits 0-2 and bit 5 (a 4-bit CLUT index, oddly
 *  packed — bit 5 supplies the top bit). */
export const BORDER_COLOUR_MASK = 0x27;
/** Cassette MIC output. */
export const BORDER_MIC = 0x08;
/** Beeper output. */
export const BORDER_BEEP = 0x10;
/** Screen off (blanks the display to the border colour). */
export const BORDER_SOFF = 0x80;
/** Keyboard bits returned by an `IN 0xFE`. */
export const BORDER_KEY_MASK = 0x1F;
/**
 * Light-pen "screen pen" status.
 *
 * Read-only, and with no light pen fitted it reads back CLEAR. That is not a
 * detail to shrug at: the ROM's raster-sync routine tests this bit and, when it
 * is set, skips the HPEN wait loop entirely and writes the palette wherever the
 * beam happens to be. Returning it set is what used to smear the boot screen's
 * colour bands across the right border.
 */
export const BORDER_SPEN = 0x20;
/** Cassette EAR input. */
export const BORDER_EAR = 0x40;

// ── Memory geometry ─────────────────────────────────────────────────────────

/** One SAM memory page. The Z80's four 16K sections each hold exactly one. */
export const SAM_PAGE_SIZE = 0x4000;

/** Internal pages fitted, by model. */
export const SAM_PAGES_256K = 16;
export const SAM_PAGES_512K = 32;
/** 16K pages in one megabyte of external RAM. */
export const SAM_EXTERNAL_PAGES_PER_MB = 64;
/** Most external RAM the megabyte interface addresses: LEPR/HEPR are 8-bit
 *  page registers, so 256 pages of 16K. SimCoupe's `MAX_EXTERNAL_MB`. */
export const SAM_MAX_EXTERNAL_MB = 4;

/** System ROM size — a single 32K EPROM, split into ROM 0 and ROM 1. */
export const SAM_ROM_SIZE = 0x8000;

// ── Palette ─────────────────────────────────────────────────────────────────

/**
 * The SAM's 128-colour palette.
 *
 * Each CLUT entry is a 7-bit code whose bits carry two levels per channel plus
 * one shared "bright" bit:
 *
 *   bit 0 = B0   bit 1 = R0   bit 2 = G0
 *   bit 3 = BRIGHT
 *   bit 4 = B1   bit 5 = R1   bit 6 = G1
 *
 * so each channel's intensity is the 3-bit value `(C1 << 2) | (C0 << 1) | BRIGHT`,
 * i.e. 0..7. Two maps are offered:
 *
 *   - `linear`   — level × 255/7, the idealised output most emulators show.
 *   - `measured` — the same ramp with the slight non-linearity of the real
 *                  resistor ladder, so mid greys sit where a real SAM puts them.
 *
 * Values are packed ABGR (0xAABBGGRR), the word order the canvas and WebGL
 * renderers consume — matching `CPC_PALETTES` and `PALETTES` in `cores/ula.ts`.
 */
export type SamColorMap = 'linear' | 'measured';

/** Channel intensity (0..7) → 8-bit level, for each colour map. */
const LEVELS: Record<SamColorMap, readonly number[]> = {
  // Exact eighths of full scale: round(level * 255 / 7).
  linear: [0, 36, 73, 109, 146, 182, 219, 255],
  // The real ladder is slightly compressed at the bottom and top.
  measured: [0, 46, 84, 118, 152, 187, 222, 255],
};

function buildSamPalette(map: SamColorMap): Uint32Array {
  const level = LEVELS[map];
  const out = new Uint32Array(128);
  for (let i = 0; i < 128; i++) {
    const bright = i & 0x08 ? 1 : 0;
    const b = (((i >> 4) & 1) << 2) | (((i >> 0) & 1) << 1) | bright;
    const r = (((i >> 5) & 1) << 2) | (((i >> 1) & 1) << 1) | bright;
    const g = (((i >> 6) & 1) << 2) | (((i >> 2) & 1) << 1) | bright;
    out[i] = ((0xFF000000 | (level[b] << 16) | (level[g] << 8) | level[r]) >>> 0);
  }
  return out;
}

export const SAM_PALETTES: Record<SamColorMap, Uint32Array> = {
  linear: buildSamPalette('linear'),
  measured: buildSamPalette('measured'),
};

/** Default palette. Kept as the fallback for code paths that don't track the
 *  selected colour map (tests, debug defaults). */
export const SAM_PALETTE: Uint32Array = SAM_PALETTES.linear;
