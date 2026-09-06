/**
 * SAM BASIC system variables.
 *
 * The SAM has its own system-variable area, and it is not the Spectrum's
 * despite sitting at a familiar-looking address. Three things about it decide
 * every reader built on top:
 *
 *  - **They live in RAM page 0, which the ROM keeps paged at 0x4000.** The
 *    Technical Manual puts the machine stack and system variables in section B
 *    (0x4000-0x5CD0) precisely so they stay put while the screen, the program
 *    and the variables area are paged in and out of the top half of memory. So
 *    a sysvar's documented address is an address in *that* window: subtract
 *    `SAM_SYSVAR_WINDOW` to index page 0 directly, which is how everything
 *    here reads them — never through the CPU's current paging, which a running
 *    program is free to change.
 *
 *  - **`SVAR n` is 0x5A00 + n.** That is the BASIC function, and it is why the
 *    manual quotes some variables by number: SVAR 566 is CHARS at 0x5C36.
 *
 *  - **The pointers into BASIC's memory are 3 bytes: page, then a 16-bit
 *    offset that ALREADY has 0x8000 added.** The ROM uses sections C and D as
 *    a rotating window onto memory, so a pointer reads as if the page it names
 *    were mapped at 0x8000 — and an offset is allowed to run past 0xBFFF into
 *    the following page's window, which is exactly what `readPointer` folds
 *    back. Reading these as flat 16-bit addresses is the single easiest way to
 *    get the BASIC area wrong: nothing in the machine is at 0x9CD5.
 *
 * Addresses transcribed from the SAM Coupé Technical Manual v3.0, "System
 * Variables" and "Major Pointers To BASIC's Memory Area".
 */

import { resolveSamPointer } from '@/basic/sam-basic-parser.ts';

/** The RAM page holding the system variables. */
export const SAM_SYSVAR_PAGE = 0;

/** Where the ROM keeps that page mapped: sysvar addresses are relative to it. */
export const SAM_SYSVAR_WINDOW = 0x4000;

/** Base of the `SVAR n` numbering — `SVAR n` is `SAM_SVARS + n`. */
export const SAM_SVARS = 0x5A00;

// ── Pointers into BASIC's memory area (3 bytes: page, offset+0x8000) ────────

/** String and array variables start. */
export const SAM_SAVARS_PTR = 0x5A81;
/** End of the numeric-variables gap. */
export const SAM_NUMEND_PTR = 0x5A84;
/** Numeric and FOR-NEXT variables start. */
export const SAM_NVARS_PTR = 0x5A87;
/** DATA pointer used by READ. */
export const SAM_DATADD_PTR = 0x5A8A;
/** End of workspace (last used byte before RAMTOP). */
export const SAM_WKEND_PTR = 0x5A8D;
/** Workspace start. */
export const SAM_WORKSP_PTR = 0x5A90;
/** Edit-line start. */
export const SAM_ELINE_PTR = 0x5A93;
/** Current character address. */
export const SAM_CHAD_PTR = 0x5A96;
/** Address of the next line in the BASIC program. */
export const SAM_NXTLINE_PTR = 0x5A9C;
/** Program start — the address of the first line's line number. */
export const SAM_PROG_PTR = 0x5A9F;
/** Last byte allocated to the BASIC program. */
export const SAM_RAMTOP_PTR = 0x5CB1;

// ── Plain 16-bit and byte variables ────────────────────────────────────────

/** MODE of the current screen: 0-3 for modes 1-4. */
export const SAM_MODE_ADDR = 0x5A40;
/** Current screen page: bit 7 clear, bits 6-5 mode, bits 4-0 page. */
export const SAM_CUSCRNP_ADDR = 0x5A78;
/** Address 256 bytes below the main character set (as the Spectrum's CHARS). */
export const SAM_CHARS_ADDR = 0x5C36;
/** Start of the channels area. */
export const SAM_CHANS_ADDR = 0x5C4F;
/** Address of CHR$ 169's definition, or 0 when undefined. */
export const SAM_HUDG_ADDR = 0x5C7D;
/** Page-allocation table: one byte per 16K page, 0xFF terminated. */
export const SAM_ALLOCT_ADDR = 0x5100;

/** A 3-byte page/offset pointer, resolved to a page and an offset within it. */
export interface SamPointer {
  /** RAM page the target lives in. */
  readonly page: number;
  /** Byte offset within that page (0..0x3FFF). */
  readonly offset: number;
  /** The offset exactly as stored, for display. */
  readonly raw: number;
}

/**
 * Read a 3-byte BASIC pointer out of the system-variable page, or null when
 * the ROM has not written one there.
 *
 * `sysvars` is RAM page 0 as a flat 16K array; `addr` is the documented
 * address in the 0x4000 window. The 0x8000-based decoding — including what
 * counts as "not a pointer" — lives in `resolveSamPointer`, so this and the
 * BASIC walkers cannot disagree about it.
 */
export function readSamPointer(sysvars: Uint8Array, addr: number): SamPointer | null {
  const at = addr - SAM_SYSVAR_WINDOW;
  const raw = ((sysvars[at + 2] ?? 0) << 8) | (sysvars[at + 1] ?? 0);
  const p = resolveSamPointer(sysvars[at] ?? 0, raw);
  return p && { page: p.page, offset: p.offset, raw };
}

/** Read a 16-bit little-endian sysvar. */
export function readSamWord(sysvars: Uint8Array, addr: number): number {
  const at = addr - SAM_SYSVAR_WINDOW;
  return ((sysvars[at + 1] ?? 0) << 8) | (sysvars[at] ?? 0);
}

/** Read a single-byte sysvar. */
export function readSamByte(sysvars: Uint8Array, addr: number): number {
  return sysvars[addr - SAM_SYSVAR_WINDOW] ?? 0;
}

/** How a sysvar is rendered in the pane. */
export type SamSysVarWidth = 8 | 16 | 'ptr' | 'char';

/** One row of the System Variables pane. */
export interface SamSysVarDef {
  readonly name: string;
  readonly addr: number;
  readonly width: SamSysVarWidth;
  readonly tip: string;
}

/**
 * The system variables worth showing, in pairs of pane columns.
 *
 * A curated list rather than all 300-odd: the ones that say what BASIC is
 * doing, where its memory is, and how the screen is set up. Each `tip` is the
 * manual's own description, shortened.
 */
export const SAM_SYSVARS: readonly (readonly [SamSysVarDef, SamSysVarDef])[] = [
  [{ name: 'PROG', addr: SAM_PROG_PTR, width: 'ptr', tip: 'Program start — address of the first line’s line number' },
   { name: 'NVARS', addr: SAM_NVARS_PTR, width: 'ptr', tip: 'Numeric and FOR-NEXT variables start' }],
  [{ name: 'NUMEND', addr: SAM_NUMEND_PTR, width: 'ptr', tip: 'End of the numeric-variables gap' },
   { name: 'SAVARS', addr: SAM_SAVARS_PTR, width: 'ptr', tip: 'String and array variables start' }],
  [{ name: 'ELINE', addr: SAM_ELINE_PTR, width: 'ptr', tip: 'Start of the line being edited' },
   { name: 'WORKSP', addr: SAM_WORKSP_PTR, width: 'ptr', tip: 'Workspace start' }],
  [{ name: 'WKEND', addr: SAM_WKEND_PTR, width: 'ptr', tip: 'End of workspace — last used byte before RAMTOP' },
   { name: 'RAMTOP', addr: SAM_RAMTOP_PTR, width: 'ptr', tip: 'Last byte allocated to the BASIC program' }],
  [{ name: 'NXTLINE', addr: SAM_NXTLINE_PTR, width: 'ptr', tip: 'Address of the next line in the program' },
   { name: 'CHAD', addr: SAM_CHAD_PTR, width: 'ptr', tip: 'Current character address' }],
  [{ name: 'DATADD', addr: SAM_DATADD_PTR, width: 'ptr', tip: 'DATA pointer used by READ' },
   { name: 'CHARS', addr: SAM_CHARS_ADDR, width: 16, tip: 'Address 256 bytes below the character set' }],
  [{ name: 'CHANS', addr: SAM_CHANS_ADDR, width: 16, tip: 'Start of the channels area' },
   { name: 'HUDG', addr: SAM_HUDG_ADDR, width: 16, tip: 'Address of CHR$ 169’s definition (0 = undefined)' }],
  [{ name: 'MODE', addr: SAM_MODE_ADDR, width: 8, tip: 'Screen MODE of the current screen: 0-3 for modes 1-4' },
   { name: 'CUSCRNP', addr: SAM_CUSCRNP_ADDR, width: 8, tip: 'Current screen page: bits 6-5 mode, bits 4-0 page' }],
  [{ name: 'CIA', addr: 0x5AAF, width: 16, tip: 'Address of the start of the current line' },
   { name: 'CSA', addr: 0x5A7B, width: 16, tip: 'Current statement address (used by DOS)' }],
  [{ name: 'FIRST', addr: 0x5A7D, width: 16, tip: 'First line number of a LIST range' },
   { name: 'LAST', addr: 0x5A7F, width: 16, tip: 'Last line number of a LIST range' }],
  [{ name: 'DEVICE', addr: 0x5A73, width: 8, tip: '0=upper window, 1=lower window, 2=printer, 3=other' },
   { name: 'CLET', addr: 0x5A74, width: 'char', tip: 'Current channel letter — K/S/P/B/T/$' }],
  [{ name: 'SLDEV', addr: 0x5A06, width: 'char', tip: 'Current device letter: T tape, D disk, N network' },
   { name: 'SELNUM', addr: 0x5A07, width: 8, tip: 'Tape save speed, or the default drive number' }],
  [{ name: 'M23PAPP', addr: 0x5A48, width: 8, tip: 'Mode 3/4 permanent PAPER' },
   { name: 'M23INKP', addr: 0x5A49, width: 8, tip: 'Mode 3/4 permanent PEN' }],
  [{ name: 'ATTRP', addr: 0x5A45, width: 8, tip: 'Permanent attributes used by modes 1 and 2' },
   { name: 'MASKP', addr: 0x5A46, width: 8, tip: 'Permanent attribute mask for modes 1 and 2' }],
  [{ name: 'XCOORD', addr: 0x5A42, width: 16, tip: 'Graphics x position, 0 at the left' },
   { name: 'YCOORD', addr: 0x5A41, width: 8, tip: 'Graphics y position, 0 at the top' }],
  [{ name: 'SPOSNU', addr: 0x5A6C, width: 16, tip: 'Upper window print position as column/row' },
   { name: 'SPOSNL', addr: 0x5A6E, width: 16, tip: 'Lower window print position as column/row' }],
  [{ name: 'FRAMIV', addr: 0x5AE2, width: 16, tip: 'Frame-interrupt vector' },
   { name: 'LINIV', addr: 0x5AE4, width: 16, tip: 'Line-interrupt vector' }],
  [{ name: 'NMIV', addr: 0x5AE0, width: 16, tip: 'Non-maskable interrupt vector (the BREAK button)' },
   { name: 'LASTSTAT', addr: 0x5AD1, width: 8, tip: 'Status-port value at the last interrupt' }],
];
