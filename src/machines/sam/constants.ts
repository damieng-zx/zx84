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

/** Raster line on which the frame interrupt is raised (first line after the
 *  display). */
export const SAM_FRAME_INT_LINE = SAM_DISPLAY_LAST_LINE;                      // 240

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
/** Light-pen "screen pen" status. */
export const BORDER_SPEN = 0x20;
/** Cassette EAR input. */
export const BORDER_EAR = 0x40;

// ── Memory geometry ─────────────────────────────────────────────────────────

/** One SAM memory page. The Z80's four 16K sections each hold exactly one. */
export const SAM_PAGE_SIZE = 0x4000;

/** Internal pages fitted, by model. */
export const SAM_PAGES_256K = 16;
export const SAM_PAGES_512K = 32;
/** Pages reachable through the external megabyte interface (1 MB / 16 K). */
export const SAM_EXTERNAL_PAGES = 64;

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
