/**
 * Acorn Atom BASIC listing and variable reader.
 *
 * Atom BASIC does **not** tokenise programs: the text space holds line records
 * of plain ASCII, which is why abbreviations (`P.` for PRINT) are accepted on
 * entry but expanded when a line is stored. The layout, from the BASIC ROM
 * source (`BASIC2`/`NEWLIN` and the Atom Technical Manual's Text Space and
 * Block Zero RAM tables):
 *
 *   text space starts at the page in zero-page `$12` (low byte 0):
 *     $2900 on a 12 KB Atom, $8200 on an unexpanded 2 KB Atom
 *
 *   each line:
 *     $0D  line-number-high  line-number-low  ASCII text…
 *   the next line starts with its own `$0D`. BASIC's line numbers are 0-32767,
 *   so LIST stops at the first record whose high byte has bit 7 set: `$0D $FF`
 *   ends a program with no machine code, and a loaded assembly block (whose
 *   pseudo-record high byte is $80-$FE) ends it too.
 *
 *   A new/empty program is just `$0D $FF` at the text space base.
 *
 * Variables (Block Zero, page 2/3):
 *   - A-Z are 4-byte little-endian signed integers in four 26-byte tables:
 *       byte 0 at $0322, byte 1 at $033D, byte 2 at $0358, byte 3 at $0373.
 *   - AA-ZZ are one-dimensional arrays of 4-byte integers, allocated upward
 *     from the free-space pointer. Their low and high addressed bytes live in
 *     two 27-byte tables at $02EB and $0306; the name's first letter selects
 *     the slot (`A` = 1 … `Z` = 26, slot 0 unused).
 *   - `@` is the PRINT field width at $0321 and is not a user variable.
 *   - The free-space pointer is `$23`/`$24`; it marks the end of the last
 *     allocated array, which gives the arrays their element counts.
 */

import type { BasicListingLine, BasicVariable } from './types.ts';

/** Zero-page: page of the bottom of the BASIC text space (low byte is 0). */
const ZP_TEXT_PAGE = 0x12;
/** Zero-page: free-space pointer, after the program text and DIM allocations. */
const ZP_FREE_SPACE = 0x23;

/** The four scalar-variable byte tables, one 26-byte column each. */
const SCALAR_TABLES = [0x0322, 0x033D, 0x0358, 0x0373] as const;
/** AA-ZZ array pointer tables: low bytes then high bytes. */
const ARRAY_LOW = 0x02EB;
const ARRAY_HIGH = 0x0306;
/** Array slot 1 is AA; slot 0 is unused. */
const ARRAY_FIRST = 1;
const ARRAY_LAST = 26;

const LINE_START = 0x0D;
/** Text space bounds: the 2 KB Atom uses the upper half of its video RAM. */
const TEXT_BASE_12K = 0x2900;
const TEXT_BASE_2K = 0x8200;
const TEXT_END_12K = 0x3C00;
const TEXT_END_2K = 0x8400;

const word = (ram: Uint8Array, addr: number): number =>
  (ram[addr] ?? 0) | ((ram[addr + 1] ?? 0) << 8);

/** A plausible text-space page for this RAM image (the 12 KB or 2 KB base). */
function textBases(ram: Uint8Array): number[] {
  const page = ram[ZP_TEXT_PAGE] << 8;
  return page === 0 ? [TEXT_BASE_12K, TEXT_BASE_2K] : [page];
}

/** A line body's bytes as plain text. Printable ASCII is kept; control codes
 *  (which Atom BASIC's LIST interprets as VDU actions) are shown as `{XX}` so
 *  a REM with embedded effects does not turn into invisible noise. */
function lineText(ram: Uint8Array, start: number, end: number): string {
  let text = '';
  for (let i = start; i < end; i++) {
    const b = ram[i];
    if (b >= 0x20 && b < 0x7F) text += String.fromCharCode(b);
    else text += `{${b.toString(16).toUpperCase().padStart(2, '0')}}`;
  }
  return text;
}

/** Walk one candidate text space. Returns null when it is not a structurally
 *  valid program. */
function walkProgram(ram: Uint8Array, base: number): BasicListingLine[] | null {
  if (base < 0x0200 || base + 2 > ram.length) return null;
  const out: BasicListingLine[] = [];
  let p = base;
  let guard = 0;

  while (p + 2 <= ram.length && guard++ < 20000) {
    if (ram[p] !== LINE_START) return null;
    const high = ram[p + 1];
    // BASIC line numbers are 15-bit (0-32767) and LIST stops at the first
    // record with bit 7 set in the high byte: the `$0D $FF` terminator, or the
    // pseudo-record that introduces a saved machine-code block.
    if ((high & 0x80) !== 0) return out;
    const low = ram[p + 2];
    const lineNumber = (high << 8) | low;

    // The body runs to the next CR; the CR is the next record's first byte.
    let end = p + 3;
    while (end < ram.length && ram[end] !== LINE_START) end++;
    if (end >= ram.length) return null;
    out.push({ lineNumber, text: lineText(ram, p + 3, end) });
    p = end;
  }
  return null;
}

/** Find and detokenise the stored BASIC program, or [] when RAM holds none. */
export function parseAtomBasic(ram: Uint8Array): BasicListingLine[] {
  if (ram.length < 0x8000) return [];
  for (const base of textBases(ram)) {
    const lines = walkProgram(ram, base);
    if (lines !== null) return lines;
  }
  // A program may have been loaded to the other text-space base, or the OS's
  // page byte may still hold the default while a machine-code loader moved
  // the pointer. Try both standard bases before giving up.
  for (const base of [TEXT_BASE_12K, TEXT_BASE_2K]) {
    const lines = walkProgram(ram, base);
    if (lines !== null) return lines;
  }
  return [];
}

/** Signed 32-bit value from the four scalar-column bytes at index `i`. */
function scalarValue(ram: Uint8Array, i: number): number {
  const b0 = ram[SCALAR_TABLES[0] + i];
  const b1 = ram[SCALAR_TABLES[1] + i];
  const b2 = ram[SCALAR_TABLES[2] + i];
  const b3 = ram[SCALAR_TABLES[3] + i];
  const v = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  return v >= 0x80000000 ? v - 0x100000000 : v;
}

/** The program's text-space base, or -1 when there is no valid program. */
function programBase(ram: Uint8Array): number {
  for (const base of textBases(ram)) {
    if (walkProgram(ram, base) !== null) return base;
  }
  for (const base of [TEXT_BASE_12K, TEXT_BASE_2K]) {
    if (walkProgram(ram, base) !== null) return base;
  }
  return -1;
}

/**
 * Parse the Atom BASIC variables from a 64 KB address-space image. Scalar
 * variables A-Z are shown when non-zero; dimensioned arrays AA-ZZ are shown
 * with the element count derivable from the allocation pointers. Returns []
 * when the RAM image does not contain a valid program/workspace.
 */
export function parseAtomBasicVariables(ram: Uint8Array): BasicVariable[] {
  if (ram.length < 0x8000) return [];
  if (programBase(ram) < 0) return [];

  const out: BasicVariable[] = [];
  for (let i = 0; i < 26; i++) {
    const value = scalarValue(ram, i);
    if (value !== 0) out.push({ name: String.fromCharCode(0x41 + i), kind: 'number', value: String(value) });
  }

  const freeSpace = word(ram, ZP_FREE_SPACE);
  const textBase = programBase(ram);
  const textEnd = textBase === TEXT_BASE_2K ? TEXT_END_2K : TEXT_END_12K;

  for (let slot = ARRAY_FIRST; slot <= ARRAY_LAST; slot++) {
    const base = (ram[ARRAY_HIGH + slot] << 8) | ram[ARRAY_LOW + slot];
    if (base === 0 || base === 0xFFFF) continue;
    if (base < textBase || base >= textEnd) continue;

    // The next dimensioned array (or the free-space pointer) marks this one's
    // end. Arrays are allocated contiguously from the bottom of free space.
    let end = freeSpace >= base && freeSpace < textEnd ? freeSpace : textEnd;
    for (let other = ARRAY_FIRST; other <= ARRAY_LAST; other++) {
      if (other === slot) continue;
      const candidate = (ram[ARRAY_HIGH + other] << 8) | ram[ARRAY_LOW + other];
      if (candidate > base && candidate < end) end = candidate;
    }
    const elements = Math.max(0, Math.floor((end - base) / 4));
    const name = String.fromCharCode(0x40 + slot).repeat(2);
    out.push({
      name: elements > 0 ? `${name}(${elements - 1})` : name,
      kind: 'array',
      detail: `base $${base.toString(16).toUpperCase().padStart(4, '0')}`,
    });
  }

  return out;
}
