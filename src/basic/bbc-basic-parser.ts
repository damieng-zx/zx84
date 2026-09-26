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

import type { BasicListingLine, BasicVariable } from './types.ts';

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

// ── Variables ───────────────────────────────────────────────────────────────
//
// The dynamic variables live in a heap that grows upward from `LOMEM` (normally
// equal to `TOP`, the end of the program) to `VARTOP`. The interpreter holds
// both in zero page: LOMEM at &00/&01 and VARTOP at &02/&03.
//
// The heap is not a flat list. A table of 64 little-endian word pointers sits
// at &0480-&04FF, one per possible initial character: the slot for character
// `c` is at `&0400 + 2·c`. Each heap entry's first two bytes link it to the
// next entry whose name shares that initial character (0 = end of chain); the
// first character itself is implied by the table slot and is not stored.
//
// An entry at its link address `p` is:
//
//     [link:2] [name…] [&00] [value…]
//
// The stored name is everything after the first character and is terminated by
// a &00 (NOT a high-bit-set final character — that convention belongs to names
// inside the tokenised program text). The value depends on the name's suffix:
//
//     float   no suffix            5 bytes: exponent, then 4 mantissa bytes
//     int     `%`                  4 bytes, signed, little-endian
//     string  `$`                  4-byte descriptor [start:2][max:1][len:1];
//                                  the characters live at `start`, which may
//                                  have been relocated to the top of the heap
//     array   name ends with `(`   [ndimOffset:1][dim:2 × ndims][elements…],
//                                  ndimOffset = 1 + 2·ndims and each stored dim
//                                  is the subscript + 1 (arrays are 0…N)
//
// The single-letter integer variables A%…Z% are the "resident integer
// variables": they are not heap entries at all but live in 4-byte slots at
// &0404 (A%) … &0468 (Z%), surviving RUN and NEW. We list the non-zero ones so
// an ordinary `B%=42` is visible. @% (&0400) is the PRINT-formatting pseudo-
// variable and is not user data, so it is omitted.
//
// FOR loops keep the loop variable as an ordinary variable; the control record
// sits on a fixed stack of ten 15-byte frames at &0500, bounded by the FOR
// stack pointer in zero page &26. A frame is:
//
//     [varAddr:2] [type:1] [step:5] [limit:5] [bodyAddr:2]
//
// where type 5 selects 5-byte floats for step/limit and any other value uses a
// 4-byte integer. We pair each live frame with its variable (by value address)
// and report it as a `for-next` entry.

/** Zero-page pointers into the BASIC workspace, from the BASIC II source. */
const ZP_LOMEM = 0x00;
const ZP_VARTOP = 0x02;
const ZP_FORSTP = 0x26;

/** Base of the per-initial-character chain table; the slot for character `c`
 *  is at `VAR_TABLE_BASE + 2·c`, so &40-&7F covers &0480-&04FF. */
const VAR_TABLE_BASE = 0x0400;
const VAR_TABLE_FIRST = 0x40;
const VAR_TABLE_LAST = 0x7F;

/** Resident integer variables: 4 bytes each; A% is index 1, Z% index 26. */
const RESIDENT_BASE = 0x0400;
const RESIDENT_A = 1;
const RESIDENT_Z = 26;

/** FOR-loop control frames: fixed stack at &0500, 15 bytes each, 10 max. */
const FOR_STACK_BASE = 0x0500;
const FOR_FRAME = 15;
const FOR_MAX = 10;
/** Type byte in a FOR frame selecting floating-point step/limit. */
const FOR_TYPE_FLOAT = 0x05;

/** Lowest address a BASIC variable heap can start at (below is workspace). */
const LOWEST_HEAP = 0x0400;

/** Safety cap on entries walked, matching the other variable parsers. */
const MAX_VARS = 2000;

const word = (ram: Uint8Array, a: number): number => ram[a] | (ram[a + 1] << 8);

/** Signed 32-bit little-endian read. */
function readS32(ram: Uint8Array, a: number): number {
  const v = (ram[a] | (ram[a + 1] << 8) | (ram[a + 2] << 16) | (ram[a + 3] << 24)) >>> 0;
  return v >= 0x80000000 ? v - 0x100000000 : v;
}

/** Tidy decimal for a computed value, trimmed to BASIC's ~9 significant
 *  figures so binary fractions don't print float noise. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return parseFloat(value.toPrecision(9)).toString();
}

/**
 * Decode a 5-byte BASIC II float at `a`: exponent first, then four mantissa
 * bytes in sign-and-magnitude order (MSB first). Restoring the implied leading
 * 1 gives a binary fraction in [0.5, 1); the value is fraction·2^(exp−128).
 * An exponent of zero means an integer held directly in the mantissa.
 */
function decodeBbcFloat(ram: Uint8Array, a: number): string {
  const exp = ram[a];
  if (exp === 0) return String(readS32(ram, a + 1));
  const m1 = ram[a + 1];
  const mantissa = ((m1 | 0x80) * 0x1000000) + (ram[a + 2] << 16) + (ram[a + 3] << 8) + ram[a + 4];
  const sign = (m1 & 0x80) !== 0 ? -1 : 1;
  return formatNumber(sign * mantissa * Math.pow(2, exp - 160));
}

/** Read a &00-terminated name remainder starting at `a`. Returns the name and
 *  the offset just past the terminator (the first value byte), or null when no
 *  terminator appears within `end`. */
function readVarName(ram: Uint8Array, a: number, end: number): { name: string; next: number } | null {
  let name = '';
  for (let i = a; i < end && name.length <= 255; i++) {
    const b = ram[i];
    if (b === 0) return { name, next: i + 1 };
    name += String.fromCharCode(b);
  }
  return null;
}

/** Decode a step/limit operand from a FOR frame of the given type. */
function decodeForOperand(ram: Uint8Array, a: number, type: number): string {
  return type === FOR_TYPE_FLOAT ? decodeBbcFloat(ram, a) : String(readS32(ram, a));
}

/** Collect the value addresses of every live FOR loop variable. The caller
 *  uses these both to name the frames and to suppress the duplicate plain
 *  entry for the same variable. */
function activeForVarAddrs(ram: Uint8Array): Set<number> {
  const addrs = new Set<number>();
  const forStp = ram[ZP_FORSTP];
  const frames = Math.min(Math.floor(forStp / FOR_FRAME), FOR_MAX);
  for (let i = 0; i < frames; i++) addrs.add(word(ram, FOR_STACK_BASE + i * FOR_FRAME));
  return addrs;
}

/** Emit the resident integer variables (A%…Z%, non-zero) and record every
 *  resident slot in `valueNames` so a FOR frame can name its variable. */
function parseResidentIntegers(
  ram: Uint8Array,
  out: BasicVariable[],
  valueNames: Map<number, string>,
  forAddrs: Set<number>,
): void {
  for (let index = RESIDENT_A; index <= RESIDENT_Z; index++) {
    const addr = RESIDENT_BASE + index * 4;
    const name = String.fromCharCode(0x40 + index) + '%';
    valueNames.set(addr, name);
    const value = readS32(ram, addr);
    if (value !== 0 && !forAddrs.has(addr)) out.push({ name, kind: 'number', value: String(value) });
  }
}

/**
 * Parse a BBC BASIC II variable heap from a 32KB RAM image (addresses ==
 * indices, i.e. `BbcMemory.ram`). Returns the resident integer variables first,
 * then heap variables in chain order, then live FOR loops. Returns [] when RAM
 * does not hold a plausible BASIC workspace.
 */
export function parseBbcBasicVariables(ram: Uint8Array): BasicVariable[] {
  if (ram.length < 0x8000) return [];
  const lomem = word(ram, ZP_LOMEM);
  const vartop = word(ram, ZP_VARTOP);
  if (lomem < LOWEST_HEAP || lomem > vartop || vartop > ram.length) return [];

  const forAddrs = activeForVarAddrs(ram);
  const valueNames = new Map<number, string>();
  const out: BasicVariable[] = [];
  parseResidentIntegers(ram, out, valueNames, forAddrs);

  for (let code = VAR_TABLE_FIRST; code <= VAR_TABLE_LAST; code++) {
    let p = word(ram, VAR_TABLE_BASE + code * 2);
    const visited = new Set<number>();
    let guard = 0;
    while (p !== 0 && guard++ < MAX_VARS && !visited.has(p)) {
      if (p < lomem || p + 2 > vartop) break;
      visited.add(p);
      const link = word(ram, p);
      const read = readVarName(ram, p + 2, vartop);
      if (!read) break;

      const name = String.fromCharCode(code) + read.name;
      const valueAddr = read.next;
      const isArray = name.endsWith('(');
      const suffix = isArray ? name[name.length - 2] : name[name.length - 1];

      if (isArray) {
        const ndimOffset = valueAddr < vartop ? ram[valueAddr] : 0;
        const ndims = (ndimOffset - 1) / 2;
        if (ndimOffset < 3 || (ndimOffset & 1) === 0 || valueAddr + ndimOffset > vartop) break;
        const dims: number[] = [];
        for (let d = 0; d < ndims; d++) dims.push(Math.max(0, word(ram, valueAddr + 1 + d * 2) - 1));
        out.push({ name: `${name.slice(0, -1)}(${dims.join(',')})`, kind: 'array' });
      } else if (suffix === '$') {
        if (valueAddr + 4 > vartop) break;
        const start = word(ram, valueAddr);
        const len = ram[valueAddr + 3];
        let text = '';
        if (start >= lomem && start + len <= vartop) {
          for (let i = 0; i < len; i++) text += String.fromCharCode(ram[start + i]);
        }
        if (!forAddrs.has(valueAddr)) out.push({ name, kind: 'string', value: text });
      } else if (suffix === '%') {
        if (valueAddr + 4 > vartop) break;
        valueNames.set(valueAddr, name);
        if (!forAddrs.has(valueAddr)) out.push({ name, kind: 'number', value: String(readS32(ram, valueAddr)) });
      } else {
        if (valueAddr + 5 > vartop) break;
        valueNames.set(valueAddr, name);
        if (!forAddrs.has(valueAddr)) out.push({ name, kind: 'number', value: decodeBbcFloat(ram, valueAddr) });
      }

      p = link;
    }
  }

  // Live FOR loops, named via the variable they control.
  const forStp = ram[ZP_FORSTP];
  const frames = Math.min(Math.floor(forStp / FOR_FRAME), FOR_MAX);
  for (let i = 0; i < frames; i++) {
    const base = FOR_STACK_BASE + i * FOR_FRAME;
    const varAddr = word(ram, base);
    const name = valueNames.get(varAddr);
    if (!name) continue;
    const type = ram[base + 2];
    out.push({
      name,
      kind: 'for-next',
      value: decodeForOperand(ram, varAddr, type),
      detail: `TO ${decodeForOperand(ram, base + 8, type)} STEP ${decodeForOperand(ram, base + 3, type)}`,
    });
  }

  return out;
}
