/**
 * Grundy NewBrain BASIC listing and variable-table parser.
 *
 * NewBrain BASIC is an incremental compiler, and everything it keeps lives in
 * one block of RAM whose base is the page-zero word B3PRM (address 0004; the
 * Z80's IY points at the same place while BASIC runs). The first 61 bytes of
 * the block are parameters and pointers, among them (offsets from the base,
 * all absolute addresses):
 *
 *   +0E STOP    top of the source-code area (which starts at +3D)
 *   +10 OTOP    top of the object-code area
 *   +12 USRSTP  user stack      +14 FORPTR  FOR blocks      +16 GSSPTR  GOSUB stack
 *   +18 STBAS   strings         +1A ARBAS   arrays          +1C SBAS    symbol table
 *   +1E LBAS    line-number table                           +20 TOP     its end
 *
 * Source lines are held tokenised, one per statement, each ending in a
 * carriage return, with the line number kept apart in the line-number table:
 * 6-byte entries of line number, source pointer and object pointer, in line
 * order. Line 0 is the command line. Tokens are bytes 0x80 and up, and the
 * same byte means two things: a statement keyword at the start of a statement
 * and a function, operator or clause word anywhere else. The tokeniser marks
 * a statement boundary inside a line with a literal `;` followed by an
 * "invisible THEN" token (0xB5), and a real THEN (0xB4) also starts one, so a
 * keyword is a statement keyword exactly when it is first in its source line
 * or follows one of those. Spaces are kept as typed, and a quoted string, a
 * REM and the rest of a DATA statement are never tokenised.
 *
 * The symbol table is 8-byte entries. The first two bytes are a name/type
 * word: bit 15 set for a variable (clear for a constant the program mentions),
 * bit 14 a string, bits 13-12 an array's dimensions, bit 11 a user-defined
 * function, and in the low ten bits the name as 37 x first letter + second
 * character (36 for none, 26-35 for a digit). A number is then a 6-byte float:
 * a byte holding the base-256 exponent doubled with the sign in its low bit,
 * and a 5-byte big-endian mantissa that counts 2^-40. A string entry holds the
 * address of its text relative to ARBAS and its length; an array entry the
 * offset of its elements from SBAS and its dimension sizes, the elements being
 * 6 bytes each.
 *
 * A FOR block is 20 bytes, the innermost loop first: the NEXT and FOR lines
 * (3 bytes each), the step and the limit (6-byte floats) and the loop
 * variable's name/type word. A GOSUB entry is 3 bytes.
 *
 * Every pointer is checked before anything is decoded: when the tables do not
 * hold together (BASIC not started, a program overwriting its own block) the
 * parsers return nothing rather than garbage.
 */

import type { BasicListingLine, BasicVariable } from './types.ts';

const B3PRM = 0x04;
const FIXED = 61;
const STOP = 0x0E;
const FORPTR = 0x14;
const GSSPTR = 0x16;
const STBAS = 0x18;
const ARBAS = 0x1A;
const SBAS = 0x1C;
const LBAS = 0x1E;
const TOP = 0x20;

const CR = 0x0D;
const TOK_REM = 142;
const TOK_DATA = 157;
const TOK_THEN = 180;
const TOK_INVISIBLE_THEN = 181;
const QUOTE = 0x22;

/** Statement keywords: the token is the index plus 128. */
const STATEMENTS = [
  'LET', 'LIST', 'NEW', 'PRINT', 'RUN', 'GOTO', 'GO TO', 'GOSUB', 'GO SUB', 'IF', 'INPUT',
  'FOR', 'NEXT', 'RETURN', 'REM', 'END', 'STOP', 'DIM', 'ON', 'OPTION', 'SAVE', 'LOAD',
  'RANDOMIZE', 'OPEN', 'CLOSE', '?', 'RET', 'RESTORE', 'READ', 'DATA', 'POKE', 'CALL',
  'CONTINUE', 'DEF', 'CLEAR', 'MERGE', 'VERIFY', 'GET', 'RESUME', 'DELETE', 'PUT', 'LINPUT',
  'REPORT', 'CONT', 'RESERVE',
];

/** Functions, operators and clause words. */
const WORDS = [
  'NOT', '+', '-', '*', '/', '^', '&', 'AND', 'OR', '<>', '<=', '>=', '=', '>', '<', 'RND',
  'PI', 'POS', 'ABS', 'ATN', 'COS', 'EXP', 'INT', 'LOG', 'SGN', 'SIN', 'SQR', 'TAN', 'TRUE',
  'FALSE', 'ASC', 'LEN', 'VAL', 'NUM', 'ASN', 'ACS', 'PEEK', 'ERRNO', 'INSTR', 'ERRLIN', 'TOP',
  'FREE', 'CHR$', 'STR$', 'RIGHT$', 'FILE$', 'LEFT$', 'MID$', 'BASE', 'IN#', 'OUT#', '#', 'THEN',
  '', 'TO', 'STEP', 'FN', 'TAB', 'ERROR', 'BREAK',
];

const word = (mem: Uint8Array, addr: number): number => mem[addr] | (mem[addr + 1] << 8);

interface Layout {
  base: number;
  stop: number;
  forptr: number;
  gssptr: number;
  stbas: number;
  arbas: number;
  sbas: number;
  lbas: number;
  top: number;
}

/** The BASIC block's pointers, or null when they do not describe a block. */
function layout(mem: Uint8Array): Layout | null {
  if (mem.length < 0x8000) return null;
  const base = word(mem, B3PRM);
  if (base < 0x40 || base + 0x40 > 0x8000) return null;
  const at = (off: number) => word(mem, base + off);
  const l: Layout = {
    base, stop: at(STOP), forptr: at(FORPTR), gssptr: at(GSSPTR), stbas: at(STBAS),
    arbas: at(ARBAS), sbas: at(SBAS), lbas: at(LBAS), top: at(TOP),
  };
  const ascending = [base + FIXED, l.stop, l.forptr, l.gssptr, l.stbas, l.arbas, l.sbas, l.lbas, l.top];
  for (let i = 1; i < ascending.length; i++) if (ascending[i] < ascending[i - 1]) return null;
  if (l.top > 0x8000 || (l.top - l.lbas) % 6 !== 0 || (l.lbas - l.sbas) % 8 !== 0) return null;
  if ((l.gssptr - l.forptr) % 20 !== 0 || (l.stbas - l.gssptr) % 3 !== 0) return null;
  return l;
}

/** A character of a quoted string, REM or DATA, as text. */
function literal(b: number): string {
  if (b >= 0x20 && b < 0x7F) return String.fromCharCode(b);
  if (b === 0xE4) return '£';
  return `{$${b.toString(16).padStart(2, '0')}}`;
}

/** Whether the bytes from `i` are `;`, spaces, then the invisible THEN that
 *  opens the next statement. */
function nextStatementAt(src: number[], i: number): boolean {
  if (src[i] !== 0x3B) return false;
  let j = i + 1;
  while (src[j] === 0x20) j++;
  return src[j] === TOK_INVISIBLE_THEN;
}

/** Detokenise one source line (its bytes up to, not including, the CR). */
function detokenise(src: number[]): string {
  let out = '';
  let statementStart = true;
  let quoted = false;
  let rest: 'none' | 'line' | 'data' = 'none';
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    if (rest === 'line') { out += literal(b); continue; }
    if (rest === 'data') {
      if (!quoted && nextStatementAt(src, i)) rest = 'none';
      else { if (b === QUOTE) quoted = !quoted; out += literal(b); continue; }
    }
    if (quoted) {
      if (b === QUOTE) quoted = false;
      out += literal(b);
      continue;
    }
    if (b === QUOTE) { quoted = true; out += '"'; continue; }
    if (b < 0x80) { out += literal(b); continue; }
    if (b === TOK_INVISIBLE_THEN) { statementStart = true; continue; }
    if (b === TOK_THEN) { out += 'THEN'; statementStart = true; continue; }
    const table = statementStart ? STATEMENTS : WORDS;
    const name = table[b - 0x80];
    out += name ?? `{$${b.toString(16).padStart(2, '0')}}`;
    if (statementStart) {
      statementStart = false;
      if (b === TOK_REM) rest = 'line';
      else if (b === TOK_DATA) rest = 'data';
    }
  }
  return out;
}

/** The program as listed lines, in line-number order. Several statements that
 *  share a line number come out as one line. */
export function parseNewBrainBasic(mem: Uint8Array): BasicListingLine[] {
  const l = layout(mem);
  if (!l) return [];
  const lines: BasicListingLine[] = [];
  for (let e = l.lbas; e < l.top; e += 6) {
    const lineNumber = word(mem, e);
    if (lineNumber === 0) continue;                    // the command line
    const ptr = word(mem, e + 2);
    if (ptr < l.base + FIXED || ptr >= l.stop) return [];
    const src: number[] = [];
    let p = ptr;
    while (p < l.stop && mem[p] !== CR) src.push(mem[p++]);
    const text = detokenise(src).replace(/^ /, '');
    const prev = lines[lines.length - 1];
    if (prev && prev.lineNumber === lineNumber) prev.text += `; ${text}`;
    else lines.push({ lineNumber, text });
  }
  return lines;
}

/** A 6-byte float as a number. */
export function newBrainFloat(mem: Uint8Array, addr: number): number {
  const b0 = mem[addr];
  let m = 0;
  for (let i = 1; i <= 5; i++) m = m * 256 + mem[addr + i];
  if (m === 0) return 0;
  const exp = ((b0 >> 1) ^ 0x40) - 0x40;              // signed 7-bit, in bytes
  const v = m * Math.pow(2, 8 * exp - 40);
  return (b0 & 1) ? -v : v;
}

/** A number as BASIC would print it, to ten significant digits. */
function formatNumber(v: number): string {
  if (v === 0) return '0';
  const s = Number(v.toPrecision(10));
  return Math.abs(s) >= 1e15 || Math.abs(s) < 1e-4 ? s.toExponential().replace('e+', 'E').replace('e', 'E') : String(s);
}

/** The name a name/type word spells: `A`, `X7`, `N$`. */
export function newBrainSymbolName(nt: number): string {
  const v = nt & 0x3FF;
  const first = Math.floor(v / 37);
  const second = v % 37;
  const letter = (n: number) => String.fromCharCode(0x41 + n);
  if (first > 25) return '?';
  let name = letter(first);
  if (second < 26) name += letter(second);
  else if (second < 36) name += String(second - 26);
  return (nt & 0x4000) ? `${name}$` : name;
}

/** A signed 16-bit field. */
const signed = (n: number): number => (n << 16) >> 16;

/** The text a string entry points at, as plain text. */
function stringText(mem: Uint8Array, l: Layout, pos: number, len: number): string {
  const at = l.arbas + signed(pos);
  if (at < l.stbas || at + len > l.arbas || len > 0x400) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += literal(mem[at + i]);
  return s;
}

/** Variables, arrays and the FOR loops now running, in that order. */
export function parseNewBrainBasicVariables(mem: Uint8Array): BasicVariable[] {
  const l = layout(mem);
  if (!l) return [];
  const out: BasicVariable[] = [];
  const bySymbol = new Map<number, number>();           // name/type word -> entry address
  // New symbols go in at the base, so the oldest is last: list in the order made.
  for (let e = l.lbas - 8; e >= l.sbas; e -= 8) {
    const nt = word(mem, e);
    if ((nt & 0x8000) === 0 || (nt & 0x0800) !== 0) continue;   // constants and DEF FN
    bySymbol.set(nt, e);
    const dims = (nt >> 12) & 3;
    const name = newBrainSymbolName(nt);
    if (dims === 0) {
      if (nt & 0x4000) {
        out.push({ name, kind: 'string', value: stringText(mem, l, word(mem, e + 2), word(mem, e + 4)) });
      } else {
        out.push({ name, kind: 'number', value: formatNumber(newBrainFloat(mem, e + 2)) });
      }
    } else {
      const d1 = word(mem, e + 4);
      const d2 = word(mem, e + 6);
      const sizes = dims === 1 ? [d1] : [d1, d2];
      out.push({ name: `${name}(${sizes.map(n => Math.max(n - 1, 0)).join(',')})`, kind: 'array' });
    }
  }
  for (let b = l.forptr; b < l.gssptr; b += 20) {
    const nt = word(mem, b + 18);
    const entry = bySymbol.get(nt);
    const step = newBrainFloat(mem, b + 6);
    const limit = newBrainFloat(mem, b + 12);
    out.push({
      name: newBrainSymbolName(nt),
      kind: 'for-next',
      value: entry === undefined ? '?' : formatNumber(newBrainFloat(mem, entry + 2)),
      detail: `TO ${formatNumber(limit)}${step === 1 ? '' : ` STEP ${formatNumber(step)}`}`,
    });
  }
  return out;
}
