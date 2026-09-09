/**
 * Camputers Lynx hardware constants.
 *
 * A 1983 British home computer: Z80A at 4MHz with a Motorola 6845 sequencing
 * the raster over three one-bit-per-pixel colour planes. Facts here are from
 * MAME's `camputers/camplynx.cpp`, the only detailed public description of the
 * machine's banking and video.
 */

/** Z80A. */
export const LYNX_CPU_CLOCK = 4_000_000;

/** 50Hz PAL frame. */
export const LYNX_FRAME_HZ = 50;
export const LYNX_LINES_PER_FRAME = 312;
export const LYNX_T_PER_FRAME = LYNX_CPU_CLOCK / LYNX_FRAME_HZ;   // 80000

/**
 * Active display. The 48K and 96K run the 6845 at 32 columns of 8 pixels for
 * 256x248 in eight colours; the 128K programs it for 64 columns and so is 512
 * across, with pixels half as wide on the same screen.
 */
export const LYNX_ACTIVE_HEIGHT = 248;
export const LYNX_ACTIVE_WIDTH_48 = 256;
export const LYNX_ACTIVE_WIDTH_128 = 512;
/** Border, in that model's own pixels, so both look the same on a TV. */
export const LYNX_BORDER_LEFT_48 = 32;
export const LYNX_BORDER_LEFT_128 = 64;
export const LYNX_BORDER_TOP = 24;

/** The framebuffer this model needs: active area plus a border either side. */
export interface LynxGeometry {
  readonly activeWidth: number;
  readonly borderLeft: number;
  readonly width: number;
  readonly height: number;
  /** Half-width pixels on the 128K, so 512 across fills the same screen. */
  readonly pixelAspectX: number;
}

export const LYNX_GEOMETRY_48: LynxGeometry = {
  activeWidth: LYNX_ACTIVE_WIDTH_48,
  borderLeft: LYNX_BORDER_LEFT_48,
  width: LYNX_ACTIVE_WIDTH_48 + LYNX_BORDER_LEFT_48 * 2,      // 320
  height: LYNX_ACTIVE_HEIGHT + LYNX_BORDER_TOP * 2,           // 296
  pixelAspectX: 1,
};

export const LYNX_GEOMETRY_128: LynxGeometry = {
  activeWidth: LYNX_ACTIVE_WIDTH_128,
  borderLeft: LYNX_BORDER_LEFT_128,
  width: LYNX_ACTIVE_WIDTH_128 + LYNX_BORDER_LEFT_128 * 2,    // 640
  height: LYNX_ACTIVE_HEIGHT + LYNX_BORDER_TOP * 2,           // 296
  pixelAspectX: 0.5,
};

/** One colour plane: 8K, one bit per pixel, eight pixels to the byte. */
export const LYNX_PLANE_SIZE = 0x2000;

/** 8K banking granularity — the Z80's 64K is eight of these. */
export const LYNX_PAGE_SIZE = 0x2000;
export const LYNX_PAGES = 8;

/** System ROM: 16K on the 48K machine (two 8K images), 24K on the 96K. */
export const LYNX_ROM_SIZE_48 = 0x4000;
export const LYNX_ROM_SIZE_96 = 0x6000;

/**
 * I/O ports. The Lynx decodes only the low byte, mirrored across the top —
 * except the keyboard, which puts the line number in A8-A11 of a read at 0x80.
 */
export const PORT_FDC_READ = 0x50;    // FD1793 status/track/sector/data
export const PORT_FDC_WRITE = 0x54;   // the same four registers, writing
export const PORT_FDC_SELECT = 0x58;  // drive/side/motor latch, and the DOS ROM
export const PORT_BANK_48 = 0x7f;     // write: bank enables (48K/96K)
export const PORT_CONTROL = 0x80;     // write: control; read: keyboard line
export const PORT_BANK_128 = 0x82;    // 128K: write bank enables, read serial/cassette
export const PORT_DAC = 0x84;         // write: sound DAC, or the cassette output
export const PORT_CRTC_ADDR = 0x86;   // 6845 address / status
export const PORT_CRTC_DATA = 0x87;   // 6845 register

/**
 * Eight colours, one bit per plane: blue is bit 2, green bit 1, red bit 0.
 * ABGR, to match the renderer's buffer.
 */
export const LYNX_PALETTE = new Uint32Array([
  0xFF000000, // black
  0xFF0000FF, // red
  0xFF00FF00, // green
  0xFF00FFFF, // yellow
  0xFFFF0000, // blue
  0xFFFF00FF, // magenta
  0xFFFFFF00, // cyan
  0xFFFFFFFF, // white
]);
