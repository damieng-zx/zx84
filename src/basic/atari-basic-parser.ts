/**
 * Atari BASIC listing and variable-table parser (400/800/XL).
 *
 * Atari BASIC keeps its whole program state in RAM, bounded by zero-page
 * pointers (Atari BASIC Reference Manual, appendix; The Atari BASIC Source
 * Book, ch. 2-3):
 *
 *   LOMEM  $80  token output buffer
 *   VNTP   $82  variable name table: names end in a byte with bit 7 set,
 *               `$` for strings and `(` for arrays; a zero byte follows
 *   VNTD   $84  end of the name table
 *   VVTP   $86  variable value table: 8 bytes per variable
 *   STMTAB $88  statement table (the program, then the direct-mode line)
 *   STMCUR $8A  current statement
 *   STARP  $8C  string/array area
 *   RUNSTK $8E  runtime stack (FOR/GOSUB)
 *   MEMTOP $90  top of BASIC's used memory
 *
 * A program line is: line number (2 bytes), line length, then statements,
 * each a statement length (offset from the line start to the next statement)
 * and a statement token followed by operator, function, variable ($80 +
 * number) and constant tokens. Numeric constants are $0E plus a 6-byte BCD
 * float; string constants are $0F, a length and the characters. REM, DATA
 * and syntax-error lines keep their raw text up to an EOL ($9B).
 *
 * Every pointer and record is checked before anything is decoded: when the
 * tables do not hold together (BASIC not started, a game owning zero page,
 * a half-loaded program) the parsers return nothing rather than garbage.
 */

import type { BasicListingLine, BasicVariable } from './types.ts';

const LOMEM = 0x80;
const VNTP = 0x82;
const VNTD = 0x84;
const VVTP = 0x86;
const STMTAB = 0x88;
const STARP = 0x8C;
const RUNSTK = 0x8E;
const MEMTOP = 0x90;

/** BASIC's tables live in RAM below the cartridge window at $A000. */
const RAM_TOP = 0xA000;
/** Lines from 32768 up are the direct-mode (immediate) line. */
const DIRECT_LINE = 0x8000;
/** Variable tokens are $80-$FF, so a program has at most 128 variables. */
const MAX_VARS = 128;

const ATASCII_EOL = 0x9B;
const TOK_NUMBER = 0x0E;
const TOK_STRING = 0x0F;
const TOK_EOS = 0x14;
const TOK_EOL = 0x16;
const FIRST_FUNCTION = 0x3D;

const STMT_REM = 0;
const STMT_DATA = 1;
const STMT_IMPLIED_LET = 54;
const STMT_ERROR = 55;

/**
 * Statement tokens 0-55 (Atari BASIC Reference Manual, appendix B). 54 is
 * the implied LET of `A=1`, which lists as nothing. 55 marks a line that
 * failed syntax checking; it lists with the same `ERROR-  ` lead-in as
 * BASIC's error messages, then its raw text.
 */
const STATEMENTS: readonly string[] = [
  'REM', 'DATA', 'INPUT', 'COLOR', 'LIST', 'ENTER', 'LET', 'IF', 'FOR', 'NEXT',
  'GOTO', 'GO TO', 'GOSUB', 'TRAP', 'BYE', 'CONT', 'COM', 'CLOSE', 'CLR', 'DEG',
  'DIM', 'END', 'NEW', 'OPEN', 'LOAD', 'SAVE', 'STATUS', 'NOTE', 'POINT', 'XIO',
  'ON', 'POKE', 'PRINT', 'RAD', 'READ', 'RESTORE', 'RETURN', 'RUN', 'STOP', 'POP',
  '?', 'GET', 'PUT', 'GRAPHICS', 'PLOT', 'POSITION', 'DOS', 'DRAWTO', 'SETCOLOR', 'LOCATE',
  'SOUND', 'LPRINT', 'CSAVE', 'CLOAD', '', 'ERROR-  ',
];

/**
 * Operator and function tokens from $12. The array and DIM-array left
 * parentheses ($38, $39) print nothing: an array's name already ends in `(`.
 * The two `=` forms are numeric and string assignment; the second run of
 * relational operators is the string comparisons.
 */
const OPERATORS: Readonly<Record<number, string>> = {
  0x12: ',', 0x13: '$', 0x14: ':', 0x15: ';', 0x16: '',
  0x17: 'GOTO', 0x18: 'GOSUB', 0x19: 'TO', 0x1A: 'STEP', 0x1B: 'THEN', 0x1C: '#',
  0x1D: '<=', 0x1E: '<>', 0x1F: '>=', 0x20: '<', 0x21: '>', 0x22: '=',
  0x23: '^', 0x24: '*', 0x25: '+', 0x26: '-', 0x27: '/',
  0x28: 'NOT', 0x29: 'OR', 0x2A: 'AND', 0x2B: '(', 0x2C: ')',
  0x2D: '=', 0x2E: '=',
  0x2F: '<=', 0x30: '<>', 0x31: '>=', 0x32: '<', 0x33: '>', 0x34: '=',
  0x35: '+', 0x36: '-',
  0x37: '(', 0x38: '', 0x39: '', 0x3A: '(', 0x3B: '(', 0x3C: ',',
  0x3D: 'STR$', 0x3E: 'CHR$', 0x3F: 'USR', 0x40: 'ASC', 0x41: 'VAL', 0x42: 'LEN',
  0x43: 'ADR', 0x44: 'ATN', 0x45: 'COS', 0x46: 'PEEK', 0x47: 'SIN', 0x48: 'RND',
  0x49: 'FRE', 0x4A: 'EXP', 0x4B: 'LOG', 0x4C: 'CLOG', 0x4D: 'SQR', 0x4E: 'SGN',
  0x4F: 'ABS', 0x50: 'INT', 0x51: 'PADDLE', 0x52: 'STICK', 0x53: 'PTRIG', 0x54: 'STRIG',
};

const word = (mem: Uint8Array, addr: number): number => mem[addr] | (mem[addr + 1] << 8);

// ── Floating point ──────────────────────────────────────────────────────────

/**
 * Decode a 6-byte Atari BCD float as BASIC prints it. Byte 0 holds the sign
 * (bit 7) and an excess-64 power of 100; bytes 1-5 are ten BCD digits with
 * the decimal point after the first byte. Zero is all zero bytes.
 *
 * Powers of 100 from -1 to 4 (0.01 up to, not including, 1E10) print in
 * full. Anything else prints as a mantissa and a signed two-digit power of
 * ten, the way the OS's float-to-ASCII routine builds it: the first byte's
 * two digits, a point, the remaining digits less trailing zeros; then a
 * leading zero digit is dropped, or else the point moves one place left
 * (and the exponent up one). So 1E-04 but 5.0E-03, 1.5E+10 and 1.0E+97.
 * Returns null for bytes that are not a float (a nibble above 9).
 */
export function decodeAtariFloat(mem: Uint8Array, addr: number): string | null {
  const head = mem[addr];
  let digits = '';
  for (let i = 1; i <= 5; i++) {
    const b = mem[addr + i];
    const hi = b >> 4, lo = b & 0x0F;
    if (hi > 9 || lo > 9) return null;
    digits += String(hi) + String(lo);
  }
  if (/^0+$/.test(digits)) return '0';

  const power = (head & 0x7F) - 64;
  let text: string;
  if (power >= -1 && power <= 4) {
    // Digits before the decimal point, counting the first byte's two.
    let point = 2 + 2 * power;
    while (digits[0] === '0') { digits = digits.slice(1); point--; }
    digits = digits.replace(/0+$/, '');
    if (point <= 0) text = `0.${'0'.repeat(-point)}${digits}`;
    else if (point >= digits.length) text = digits + '0'.repeat(point - digits.length);
    else text = `${digits.slice(0, point)}.${digits.slice(point)}`;
  } else {
    const rest = digits.slice(2).replace(/0+$/, '');
    let exp = 2 * power;
    let mant: string;
    if (digits[0] === '0') {
      mant = rest ? `${digits[1]}.${rest}` : digits[1];
    } else {
      mant = `${digits[0]}.${digits[1]}${rest}`;
      exp++;
    }
    text = `${mant}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  return (head & 0x80) !== 0 ? `-${text}` : text;
}

// ── Text ────────────────────────────────────────────────────────────────────

/**
 * ATASCII to plain text. Letters, digits and punctuation come through (an
 * inverse-video character reads as its normal form); graphics and cursor
 * controls have no plain-text form and show as `{XX}`.
 */
function atascii(b: number): string {
  const c = b & 0x7F;
  if ((c >= 0x20 && c <= 0x5F) || (c >= 0x61 && c <= 0x7A) || c === 0x7C) return String.fromCharCode(c);
  return `{${b.toString(16).toUpperCase().padStart(2, '0')}}`;
}

function atasciiRun(mem: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let a = start; a < end; a++) s += atascii(mem[a]);
  return s;
}

// ── Tables ──────────────────────────────────────────────────────────────────

interface Tables {
  vvtp: number;
  stmtab: number;
  starp: number;
  runstk: number;
  /** Raw names from the VNT, ending `$` for strings and `(` for arrays. */
  names: string[];
}

/** Read and cross-check the zero-page pointers and the variable name table. */
function readTables(mem: Uint8Array): Tables | null {
  if (mem.length < RAM_TOP) return null;
  const lomem = word(mem, LOMEM);
  const vntp = word(mem, VNTP);
  const vntd = word(mem, VNTD);
  const vvtp = word(mem, VVTP);
  const stmtab = word(mem, STMTAB);
  const starp = word(mem, STARP);
  const runstk = word(mem, RUNSTK);
  const memtop = word(mem, MEMTOP);
  // The areas sit in this order, each following the last (Source Book, ch. 2).
  if (!(lomem >= 0x0100 && lomem < vntp && vntp <= vntd && vntd < vvtp && vvtp <= stmtab
    && stmtab < starp && starp <= runstk && runstk <= memtop && memtop <= RAM_TOP)) return null;
  const count = (stmtab - vvtp) / 8;
  if (!Number.isInteger(count) || count > MAX_VARS) return null;

  const names: string[] = [];
  let name = '';
  for (let a = vntp; a < vntd; a++) {
    const b = mem[a];
    const c = String.fromCharCode(b & 0x7F);
    // Names are a letter then letters and digits, with an optional $ or (.
    if (name === '' ? !/[A-Z]/.test(c) : !/[A-Z0-9$(]/.test(c)) return null;
    name += c;
    if (b & 0x80) { names.push(name); name = ''; }
  }
  if (name !== '' || names.length !== count) return null;
  // Each value-table entry carries its own variable number.
  for (let i = 0; i < count; i++) if (mem[vvtp + i * 8 + 1] !== i) return null;
  return { vvtp, stmtab, starp, runstk, names };
}

// ── Listing ─────────────────────────────────────────────────────────────────

/** Detokenise one statement's tokens, or null if they do not parse. */
function statementBody(mem: Uint8Array, start: number, end: number, names: readonly string[]): string | null {
  let s = '';
  for (let a = start; a < end;) {
    const t = mem[a++];
    if (t >= 0x80) {
      const name = names[t - 0x80];
      if (name === undefined) return null;
      s += name;
    } else if (t === TOK_NUMBER) {
      if (a + 6 > end) return null;
      const n = decodeAtariFloat(mem, a);
      if (n === null) return null;
      s += n;
      a += 6;
    } else if (t === TOK_STRING) {
      const len = mem[a++];
      if (a + len > end) return null;
      s += `"${atasciiRun(mem, a, a + len)}"`;
      a += len;
    } else {
      const op = OPERATORS[t];
      if (op === undefined) return null;
      // Word operators stand apart from their operands; functions do not.
      s += /^[A-Z]/.test(op) && t < FIRST_FUNCTION ? ` ${op} ` : op;
    }
  }
  return s;
}

/** Detokenise one program line, or null if the record is malformed. */
function listLine(mem: Uint8Array, line: number, len: number, names: readonly string[]): string | null {
  let text = '';
  let offset = 3;
  while (offset < len) {
    const next = mem[line + offset];
    if (next <= offset + 1 || next > len) return null;
    const token = mem[line + offset + 1];
    const keyword = STATEMENTS[token];
    if (keyword === undefined) return null;
    const bodyStart = line + offset + 2;
    const bodyEnd = line + next;
    if (token === STMT_REM || token === STMT_DATA || token === STMT_ERROR) {
      // Raw text up to the EOL that ends the line.
      let end = bodyStart;
      while (end < bodyEnd && mem[end] !== ATASCII_EOL) end++;
      text += `${keyword} ${atasciiRun(mem, bodyStart, end)}`;
    } else {
      const last = mem[bodyEnd - 1];
      if (last !== TOK_EOS && last !== TOK_EOL) return null;
      const body = statementBody(mem, bodyStart, bodyEnd, names);
      if (body === null) return null;
      text += token === STMT_IMPLIED_LET ? body : `${keyword} ${body}`;
    }
    offset = next;
  }
  return text.trimEnd();
}

/**
 * Detokenise the program in the statement table. `mem` is the 64K address
 * space (or BASIC's RAM). Empty when the tables do not check out.
 */
export function parseAtariBasic(mem: Uint8Array): BasicListingLine[] {
  const t = readTables(mem);
  if (!t) return [];
  const lines: BasicListingLine[] = [];
  let prev = -1;
  for (let addr = t.stmtab; addr + 3 <= t.starp;) {
    const lineNumber = word(mem, addr);
    if (lineNumber >= DIRECT_LINE) break;
    const len = mem[addr + 2];
    if (lineNumber <= prev || len < 6 || addr + len > t.starp) return [];
    const text = listLine(mem, addr, len, t.names);
    if (text === null) return [];
    lines.push({ lineNumber, text });
    prev = lineNumber;
    addr += len;
  }
  return lines;
}

// ── Variables ───────────────────────────────────────────────────────────────

const TYPE_SCALAR = 0x00;
const TYPE_ARRAY = 0x40;
const TYPE_STRING = 0x80;
/** Set once DIM has given the array or string its storage. */
const DIMENSIONED = 0x01;

/**
 * Decode the variable value table. Scalars show their value; strings their
 * current contents (STARP + offset, current length, DIM length); arrays their
 * extents as DIM gave them (stored as extent + 1).
 */
export function parseAtariBasicVariables(mem: Uint8Array): BasicVariable[] {
  const t = readTables(mem);
  if (!t) return [];
  const vars: BasicVariable[] = [];
  for (let i = 0; i < t.names.length; i++) {
    const e = t.vvtp + i * 8;
    const type = mem[e];
    const raw = t.names[i];
    const kind = type & 0xC0;
    if (kind === TYPE_SCALAR) {
      if (/[$(]$/.test(raw)) return [];
      const value = decodeAtariFloat(mem, e + 2);
      if (value === null) return [];
      vars.push({ name: raw, kind: 'number', value });
    } else if (kind === TYPE_STRING) {
      if (!raw.endsWith('$')) return [];
      if (!(type & DIMENSIONED)) {
        vars.push({ name: raw, kind: 'string', value: '' });
        continue;
      }
      const start = t.starp + word(mem, e + 2);
      const len = word(mem, e + 4);
      const dim = word(mem, e + 6);
      if (len > dim || start + dim > t.runstk) return [];
      vars.push({ name: raw, kind: 'string', value: atasciiRun(mem, start, start + len) });
    } else if (kind === TYPE_ARRAY) {
      if (!raw.endsWith('(')) return [];
      const base = raw.slice(0, -1);
      if (!(type & DIMENSIONED)) {
        vars.push({ name: `${base}()`, kind: 'array', detail: 'not dimensioned' });
        continue;
      }
      const d1 = word(mem, e + 4);
      const d2 = word(mem, e + 6);
      if (d1 === 0 || d2 === 0 || t.starp + word(mem, e + 2) + d1 * d2 * 6 > t.runstk) return [];
      vars.push({ name: `${base}(${d2 > 1 ? `${d1 - 1},${d2 - 1}` : d1 - 1})`, kind: 'array' });
    } else {
      return [];
    }
  }
  return vars;
}

// ── ROM identification ─────────────────────────────────────────────────────

const ASCII = (s: string): number[] => [...s].map((c, i, a) => c.charCodeAt(0) | (i === a.length - 1 ? 0x80 : 0));
/** REM, DATA and INPUT from the statement name table: each name ends with
 *  bit 7 set. Atari BASIC puts a 2-byte syntax-table address before each name;
 *  Altirra BASIC, which keeps Atari BASIC's tokens and zero-page layout, packs
 *  the names back to back. */
const SNTAB_HEAD = [ASCII('REM'), ASCII('DATA'), ASCII('INPUT')];
/** Bytes between one name and the next: Atari BASIC, Altirra BASIC. */
const SNTAB_GAPS = [2, 0];

/**
 * Whether an 8K image (the $A000 window as the CPU sees it) is Atari BASIC or
 * Altirra BASIC, recognised by its statement name table. Lets the host show a
 * listing only while BASIC owns the zero-page pointers above.
 */
export function isAtariBasicRom(rom: Uint8Array): boolean {
  const [rem, data, input] = SNTAB_HEAD;
  const at = (a: number, bytes: number[]) => bytes.every((b, i) => rom[a + i] === b);
  for (let a = 0; a + 20 < rom.length; a++) {
    if (!at(a, rem)) continue;
    for (const gap of SNTAB_GAPS) {
      const d = a + rem.length + gap;
      if (at(d, data) && at(d + data.length + gap, input)) return true;
    }
  }
  return false;
}
