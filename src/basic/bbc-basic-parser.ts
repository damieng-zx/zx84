/**
 * BBC BASIC (BASIC II, 6502) detokeniser.
 *
 * Reads the tokenised program the MOS/BASIC interpreter stores from `PAGE`
 * upward and renders it as a listing. The in-memory record layout was verified
 * against two independent sources:
 *
 *   8bs.com's "How a BASIC program is actually stored in memory" (a worked
 *   PAGE-upward hex dump) and the ROM-validated oaknut `detokeniser.py`, whose
 *   docstring is taken from the BASIC II disassembly.
 *
 *   Program terminator: `&FF` where the next line's high byte would be
 *   (the 8bs dump ends `... &0D &FF`).
 *
 *   Each line, starting at its line-number high byte, is:
 *
 *     [lineNoHi] [lineNoLo] [length] [body…] [&0D]
 *
 *   where `length` is a SINGLE byte counting the two line-number bytes, the
 *   length byte itself, the body and the trailing `&0D`, i.e.
 *   `length = 4 + len(body)`. The next line starts at `line + length`.
 *
 *   (A leading `&0D` sits at PAGE itself; it is the "start of line" marker the
 *   ROM writes before the first record, not part of any line.)
 *
 * The token table is BASIC II's, transcribed from the ROM's keyword table at
 * `&8071`-`&836C` (oaknut's `tokens.py`, cross-checked against MMFS's
 * `BeebUtils.pm` and the PDP11 BASIC disassembly). Keywords are single bytes
 * `&80`-`&FF`; `&8D` is the special 3-byte line-number reference; `&CE` is an
 * unused gap. The five tokens after `WIDTH` (`&CF`-`&D3`) are the assignment
 * forms the de-tokeniser needs to render the pseudo-variables.
 */

import type { BasicListingLine } from './types.ts';

/** Tokenised line-number reference; followed by three encoded bytes. */
const LINE_REF_TOKEN = 0x8D;
/** `REM` and `DATA` stop tokenising: the rest of the line is literal. */
const REM_TOKEN = 0xF4;
const DATA_TOKEN = 0xDC;

/** Standard BASIC program bases: PAGE without and with DFS fitted. PAGE is a
 *  page-aligned value whose high byte the OS keeps at zero-page &18. */
const PAGE_DFS = 0x1900;
const PAGE_TAPE = 0x0E00;
const PAGE_POINTER = 0x18;
/** Lowest address a program can occupy (below this is OS/BASIC workspace). */
const LOWEST_PAGE = 0x0E00;
const HIGHEST_PAGE = 0x7F00;

/**
 * BASIC II keywords, byte → spelling. Every token `&80`-`&FF` except the
 * line-reference `&8D` and the gap `&CE`, plus the assignment-form pseudo-
 * variables (`&CF`-`&D3`). Source: the ROM table at `&8071` (via oaknut's
 * `tokens.py`); spot-checked `&80`=AND, `&81`=DIV, `&82`=EOR, `&C0`=LEFT$(`,
 * `&C1`=MID$(` and `&F1`=PRINT against MMFS and the PDP11 disassembly.
 */
const KEYWORDS: Record<number, string> = {
  0x80: 'AND', 0x81: 'DIV', 0x82: 'EOR', 0x83: 'MOD', 0x84: 'OR',
  0x85: 'ERROR', 0x86: 'LINE', 0x87: 'OFF', 0x88: 'STEP', 0x89: 'SPC',
  0x8A: 'TAB(', 0x8B: 'ELSE', 0x8C: 'THEN', 0x8E: 'OPENIN', 0x8F: 'PTR',
  0x90: 'PAGE', 0x91: 'TIME', 0x92: 'LOMEM', 0x93: 'HIMEM', 0x94: 'ABS',
  0x95: 'ACS', 0x96: 'ADVAL', 0x97: 'ASC', 0x98: 'ASN', 0x99: 'ATN',
  0x9A: 'BGET', 0x9B: 'COS', 0x9C: 'COUNT', 0x9D: 'DEG', 0x9E: 'ERL',
  0x9F: 'ERR', 0xA0: 'EVAL', 0xA1: 'EXP', 0xA2: 'EXT', 0xA3: 'FALSE',
  0xA4: 'FN', 0xA5: 'GET', 0xA6: 'INKEY', 0xA7: 'INSTR(', 0xA8: 'INT',
  0xA9: 'LEN', 0xAA: 'LN', 0xAB: 'LOG', 0xAC: 'NOT', 0xAD: 'OPENUP',
  0xAE: 'OPENOUT', 0xAF: 'PI', 0xB0: 'POINT(', 0xB1: 'POS', 0xB2: 'RAD',
  0xB3: 'RND', 0xB4: 'SGN', 0xB5: 'SIN', 0xB6: 'SQR', 0xB7: 'TAN',
  0xB8: 'TO', 0xB9: 'TRUE', 0xBA: 'USR', 0xBB: 'VAL', 0xBC: 'VPOS',
  0xBD: 'CHR$', 0xBE: 'GET$', 0xBF: 'INKEY$', 0xC0: 'LEFT$(', 0xC1: 'MID$(',
  0xC2: 'RIGHT$(', 0xC3: 'STR$', 0xC4: 'STRING$(', 0xC5: 'EOF', 0xC6: 'AUTO',
  0xC7: 'DELETE', 0xC8: 'LOAD', 0xC9: 'LIST', 0xCA: 'NEW', 0xCB: 'OLD',
  0xCC: 'RENUMBER', 0xCD: 'SAVE', 0xCF: 'PTR', 0xD0: 'PAGE', 0xD1: 'TIME',
  0xD2: 'LOMEM', 0xD3: 'HIMEM', 0xD4: 'SOUND', 0xD5: 'BPUT', 0xD6: 'CALL',
  0xD7: 'CHAIN', 0xD8: 'CLEAR', 0xD9: 'CLOSE', 0xDA: 'CLG', 0xDB: 'CLS',
  0xDC: 'DATA', 0xDD: 'DEF', 0xDE: 'DIM', 0xDF: 'DRAW', 0xE0: 'END',
  0xE1: 'ENDPROC', 0xE2: 'ENVELOPE', 0xE3: 'FOR', 0xE4: 'GOSUB', 0xE5: 'GOTO',
  0xE6: 'GCOL', 0xE7: 'IF', 0xE8: 'INPUT', 0xE9: 'LET', 0xEA: 'LOCAL',
  0xEB: 'MODE', 0xEC: 'MOVE', 0xED: 'NEXT', 0xEE: 'ON', 0xEF: 'VDU',
  0xF0: 'PLOT', 0xF1: 'PRINT', 0xF2: 'PROC', 0xF3: 'READ', 0xF4: 'REM',
  0xF5: 'REPEAT', 0xF6: 'REPORT', 0xF7: 'RESTORE', 0xF8: 'RETURN', 0xF9: 'RUN',
  0xFA: 'STOP', 0xFB: 'COLOUR', 0xFC: 'TRACE', 0xFD: 'UNTIL', 0xFE: 'WIDTH',
  0xFF: 'OSCLI',
};

/** Decode the 3-byte line-number reference following `&8D` at `i`. The ROM
 *  lifts the number's high bits into a scrambled control byte and stores the
 *  two low six-bit groups with bit 6 set, so none can collide with `&0D`.
 *  Returns the number and the offset just past the reference. */
function decodeLineRef(ram: Uint8Array, i: number, end: number): { value: number; next: number } {
  if (i + 3 > end) return { value: 0, next: end };
  const ctrl = ram[i];
  const lo = (((ctrl << 2) & 0xC0) ^ ram[i + 1]) & 0xFF;
  const hi = (((ctrl << 4) & 0xC0) ^ ram[i + 2]) & 0xFF;
  return { value: lo + 256 * hi, next: i + 3 };
}

/** Detokenise one line body (between the length byte and the trailing `&0D`). */
function detokenize(ram: Uint8Array, start: number, end: number): string {
  let out = '';
  let inString = false;
  let literal = false;                 // set after REM / DATA: copy the rest raw
  let i = start;

  while (i < end) {
    const b = ram[i];

    if (literal) { out += String.fromCharCode(b); i++; continue; }

    if (inString) {
      out += String.fromCharCode(b);
      if (b === 0x22) inString = false;   // closing quote
      i++;
      continue;
    }

    if (b === 0x22) { inString = true; out += '"'; i++; continue; }

    if (b === REM_TOKEN || b === DATA_TOKEN) {
      out += KEYWORDS[b];
      literal = true;
      i++;
      continue;
    }

    if (b === LINE_REF_TOKEN) {
      const ref = decodeLineRef(ram, i + 1, end);
      out += String(ref.value);
      i = ref.next;
      continue;
    }

    if (b >= 0x80) {
      out += KEYWORDS[b] ?? `{${b.toString(16).toUpperCase().padStart(2, '0')}}`;
      i++;
      continue;
    }

    out += String.fromCharCode(b);
    i++;
  }
  return out;
}

/** True when a structurally valid program runs from `page` to its `&FF`
 *  terminator. Used to tell the real PAGE from DFS workspace / empty RAM. */
function isValidProgram(ram: Uint8Array, page: number): boolean {
  let o = page;
  if (o < 0 || o >= ram.length) return false;
  if (ram[o] === 0x0D) o++;            // the start-of-line marker at PAGE
  let guard = 0;
  while (o + 3 <= ram.length && guard++ < 20000) {
    if (ram[o] === 0xFF) return true;  // terminator: no high line-number byte
    const len = ram[o + 2];
    if (len < 4 || o + len > ram.length) return false;
    if (ram[o + len - 1] !== 0x0D) return false;
    o += len;
  }
  return false;
}

/** Locate PAGE. Prefer the OS's zero-page pointer, then the two standard bases,
 *  then scan: DFS workspace can leave stray bytes that look like a short line,
 *  so a full clean walk to the terminator is the test. */
function findPage(ram: Uint8Array): number {
  const zpPage = ram[PAGE_POINTER] << 8;   // low byte of PAGE is always &00
  if (isValidProgram(ram, zpPage)) return zpPage;
  if (isValidProgram(ram, PAGE_DFS)) return PAGE_DFS;
  if (isValidProgram(ram, PAGE_TAPE)) return PAGE_TAPE;
  for (let page = LOWEST_PAGE; page < HIGHEST_PAGE; page++) {
    if (isValidProgram(ram, page)) return page;
  }
  return -1;
}

/**
 * Parse a BBC BASIC II program from a RAM image (addresses == indices, i.e. the
 * 32KB `BbcMemory.ram` or the low half of `memory.snapshot()`). Returns the
 * detokenised listing, or `[]` when RAM does not hold a structurally valid
 * program.
 */
export function parseBbcBasic(ram: Uint8Array): BasicListingLine[] {
  const page = findPage(ram);
  if (page < 0) return [];

  const out: BasicListingLine[] = [];
  let o = page;
  if (ram[o] === 0x0D) o++;              // skip the marker at PAGE
  let guard = 0;

  while (o + 3 <= ram.length && guard++ < 20000) {
    if (ram[o] === 0xFF) break;          // end-of-program terminator
    const lineNumber = (ram[o] << 8) | ram[o + 1];
    const len = ram[o + 2];
    if (len < 4 || o + len > ram.length) break;
    if (ram[o + len - 1] !== 0x0D) break;

    out.push({ lineNumber, text: detokenize(ram, o + 3, o + len - 1) });
    o += len;
  }
  return out;
}
