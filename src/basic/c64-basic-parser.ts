/**
 * Commodore 64 BASIC V2 listing and variable-table parser.
 *
 * BASIC V2 keeps its state in RAM, bounded by zero-page pointers (Mapping the
 * Commodore 64, $2B-$37):
 *
 *   TXTTAB $2B  start of the program (normally $0801)
 *   VARTAB $2D  end of the program = start of the simple variables
 *   ARYTAB $2F  end of the simple variables = start of the arrays
 *   STREND $31  end of the arrays = bottom of free memory
 *
 * A program line is a link to the next line (2 bytes, zero at the end), the
 * line number (2 bytes), then tokens up to a zero byte. Tokens are $80-$CB
 * and $FF (pi); REM keeps the rest of its line as typed, DATA the rest of its
 * statement, and a quoted string is never tokenised.
 *
 * A simple variable is 7 bytes: two name characters whose bit 7 gives the type
 * (neither set = real, only the second = string, both = integer, only the
 * first = a DEF FN), then 5 value bytes — a real is a 5-byte float, an
 * integer is a big-endian word, a string is its length and a pointer. An
 * array is its name, the offset to the next array, the dimension count, each
 * dimension's size (big-endian, last subscript first) and then the elements.
 *
 * FOR loops live on the 6502 stack: an 18-byte frame led by the token $81
 * (variable address, STEP, its sign, the TO limit, line, text pointer); a
 * GOSUB is a 5-byte frame led by $8D.
 *
 * Every pointer is checked before anything is decoded: when the tables do not
 * hold together (BASIC not started, a game owning zero page) the parsers
 * return nothing rather than garbage.
 */

import type { BasicListingLine, BasicVariable } from './types.ts';

const TXTTAB = 0x2B;
const VARTAB = 0x2D;
const ARYTAB = 0x2F;
const STREND = 0x31;

const TOK_FOR = 0x81;
const TOK_DATA = 0x83;
const TOK_REM = 0x8F;
const TOK_GOSUB = 0x8D;
const TOK_PI = 0xFF;

const FOR_FRAME = 18;
const GOSUB_FRAME = 5;
/** Where BASIC's frames end: just under its two return addresses. */
const STACK_TOP = 0x01F9;

const TOKENS = [
  'END', 'FOR', 'NEXT', 'DATA', 'INPUT#', 'INPUT', 'DIM', 'READ', 'LET', 'GOTO', 'RUN', 'IF',
  'RESTORE', 'GOSUB', 'RETURN', 'REM', 'STOP', 'ON', 'WAIT', 'LOAD', 'SAVE', 'VERIFY', 'DEF',
  'POKE', 'PRINT#', 'PRINT', 'CONT', 'LIST', 'CLR', 'CMD', 'SYS', 'OPEN', 'CLOSE', 'GET', 'NEW',
  'TAB(', 'TO', 'FN', 'SPC(', 'THEN', 'NOT', 'STEP', '+', '-', '*', '/', '^', 'AND', 'OR', '>',
  '=', '<', 'SGN', 'INT', 'ABS', 'USR', 'FRE', 'POS', 'SQR', 'RND', 'LOG', 'EXP', 'COS', 'SIN',
  'TAN', 'ATN', 'PEEK', 'LEN', 'STR$', 'VAL', 'ASC', 'CHR$', 'LEFT$', 'RIGHT$', 'MID$', 'GO',
];

/** Control codes as petcat spells them, so a listing round-trips by eye. */
const CONTROL_NAMES: Record<number, string> = {
  5: 'wht', 17: 'down', 18: 'rvs on', 19: 'home', 20: 'del', 28: 'red', 29: 'right', 30: 'grn',
  31: 'blu', 129: 'orange', 133: 'f1', 134: 'f3', 135: 'f5', 136: 'f7', 137: 'f2', 138: 'f4',
  139: 'f6', 140: 'f8', 141: 'shift return', 144: 'blk', 145: 'up', 146: 'rvs off', 147: 'clr',
  148: 'inst', 149: 'brown', 150: 'lred', 151: 'dgry', 152: 'mgry', 153: 'lgrn', 154: 'lblu',
  155: 'lgry', 156: 'pur', 157: 'left', 158: 'yel', 159: 'cyn', 160: 'sh space',
};

const word = (mem: Uint8Array, addr: number): number => mem[addr] | (mem[addr + 1] << 8);

/** A character of a quoted string or REM, as text. */
function petscii(b: number): string {
  if (b >= 0x20 && b <= 0x5B) return String.fromCharCode(b);
  if (b === 0x5C) return '£';
  if (b === 0x5D) return ']';
  if (b === 0x5E) return '↑';
  if (b === 0x5F) return '←';
  const name = CONTROL_NAMES[b];
  return name ? `{${name}}` : `{$${b.toString(16).padStart(2, '0')}}`;
}

/** Detokenise one line body (up to, not including, its terminating zero). */
function detokenizeLine(mem: Uint8Array, start: number, end: number): string {
  let text = '';
  let quoted = false;
  let literal = false;     // after REM: the rest of the line; after DATA: to the colon
  let toColon = false;
  for (let addr = start; addr < end; addr++) {
    const b = mem[addr];
    if (b === 0x22) quoted = !quoted;
    if (quoted || literal) {
      if (literal && !quoted && toColon && b === 0x3A) { literal = false; toColon = false; text += ':'; continue; }
      text += b === 0x22 ? '"' : petscii(b);
      continue;
    }
    if (b === TOK_PI) { text += 'π'; continue; }
    if (b >= 0x80 && b < 0x80 + TOKENS.length) {
      text += TOKENS[b - 0x80];
      if (b === TOK_REM) literal = true;
      else if (b === TOK_DATA) { literal = true; toColon = true; }
      continue;
    }
    text += b >= 0x20 && b < 0x80 ? petscii(b) : `{$${b.toString(16).padStart(2, '0')}}`;
  }
  return text;
}

/** The pointers, if they describe a believable program image; else null. */
function bounds(ram: Uint8Array): { txt: number; vars: number; ary: number; end: number } | null {
  if (ram.length < 0x10000) return null;
  const txt = word(ram, TXTTAB);
  const vars = word(ram, VARTAB);
  const ary = word(ram, ARYTAB);
  const end = word(ram, STREND);
  if (txt < 0x0200 || txt > vars || vars > ary || ary > end || end > 0xA000) return null;
  return { txt, vars, ary, end };
}

/** Parse the BASIC program at TXTTAB from a 64K RAM image. */
export function parseC64Basic(ram: Uint8Array): BasicListingLine[] {
  const b = bounds(ram);
  if (!b || b.vars - b.txt < 2) return [];
  const lines: BasicListingLine[] = [];
  let addr = b.txt;
  for (let guard = 0; guard < 20000 && addr + 4 <= b.vars; guard++) {
    const next = word(ram, addr);
    if (next === 0) break;
    if (next <= addr + 4 || next > b.vars + 2) return lines;
    // The body ends at its zero byte, which is the byte before the next link.
    lines.push({ lineNumber: word(ram, addr + 2), text: detokenizeLine(ram, addr + 4, next - 1) });
    addr = next;
  }
  return lines;
}

// ── Numbers ────────────────────────────────────────────────────────────────

/** A BASIC float (exponent byte, then four mantissa bytes with the sign in bit 7 of the first), as BASIC prints it. */
export function formatC64Float(mem: Uint8Array, addr: number): string {
  const exp = mem[addr];
  if (exp === 0) return '0';
  const negative = (mem[addr + 1] & 0x80) !== 0;
  const mant = ((mem[addr + 1] | 0x80) * 0x1000000 + (mem[addr + 2] << 16) + (mem[addr + 3] << 8) + mem[addr + 4]) / 0x100000000;
  const value = mant * Math.pow(2, exp - 128);
  const sign = negative ? '-' : '';
  // Round to the nine significant digits BASIC prints first: .01 is stored a hair under .01.
  const abs = Number(Math.abs(value).toPrecision(9));
  // BASIC goes scientific outside 0.01..999999999.
  if (abs >= 1e9 || abs < 0.01) {
    const [m, e] = abs.toExponential(8).split('e');
    const digits = m.replace(/\.?0+$/, '');
    const power = Number(e);
    return `${sign}${digits}E${power < 0 ? '-' : '+'}${Math.abs(power).toString().padStart(2, '0')}`;
  }
  const fixed = abs.toString();
  return sign + fixed.replace(/^0\./, '.');
}

function varName(ram: Uint8Array, addr: number): { name: string; kind: 'real' | 'string' | 'int' | 'fn' } {
  const a = ram[addr];
  const c = ram[addr + 1];
  const kind = (a & 0x80) !== 0 ? ((c & 0x80) !== 0 ? 'int' : 'fn') : ((c & 0x80) !== 0 ? 'string' : 'real');
  const second = c & 0x7F;
  const name = String.fromCharCode(a & 0x7F) + (second ? String.fromCharCode(second) : '')
    + (kind === 'string' ? '$' : kind === 'int' ? '%' : '');
  return { name, kind };
}

/** A string variable's text: its descriptor at `addr` (length, pointer). */
function stringValue(ram: Uint8Array, addr: number): string {
  const len = ram[addr];
  const ptr = word(ram, addr + 1);
  if (len === 0) return '';
  if (ptr + len > ram.length) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += petscii(ram[ptr + i]);
  return s;
}

/** Frames from `at` run unbroken to the top of BASIC's stack. */
function frameChain(ram: Uint8Array, at: number): boolean {
  let p = at;
  while (p < STACK_TOP) {
    if (ram[p] === TOK_FOR) p += FOR_FRAME;
    else if (ram[p] === TOK_GOSUB) p += GOSUB_FRAME;
    else return false;
  }
  return p === STACK_TOP;
}

/** The simple variables, the arrays, and the FOR loops in progress. */
export function parseC64BasicVariables(ram: Uint8Array): BasicVariable[] {
  const b = bounds(ram);
  if (!b) return [];
  const vars: BasicVariable[] = [];

  for (let addr = b.vars; addr + 7 <= b.ary && vars.length < 512; addr += 7) {
    const { name, kind } = varName(ram, addr);
    if (kind === 'fn') continue;
    if (kind === 'string') vars.push({ name, kind: 'string', value: stringValue(ram, addr + 2) });
    else if (kind === 'int') {
      const v = (ram[addr + 2] << 8) | ram[addr + 3];
      vars.push({ name, kind: 'number', value: String(v >= 0x8000 ? v - 0x10000 : v) });
    } else vars.push({ name, kind: 'number', value: formatC64Float(ram, addr + 2) });
  }

  for (let addr = b.ary; addr + 7 <= b.end && vars.length < 512;) {
    const { name, kind } = varName(ram, addr);
    const next = addr + word(ram, addr + 2);
    const dims = ram[addr + 4];
    if (dims === 0 || next <= addr + 5 + dims * 2 || next > b.end) break;
    const extents: number[] = [];
    for (let d = 0; d < dims; d++) {
      const o = addr + 5 + d * 2;
      extents.push(Math.max(0, ((ram[o] << 8) | ram[o + 1]) - 1));
    }
    vars.push({ name: `${name}(${extents.reverse().join(',')})`, kind: 'array' });
    addr = next;
    if (kind === 'fn') break;
  }

  // FOR loops in progress, innermost first. BASIC's frames sit on the stack
  // just under its two return addresses, ending at $01F9; the stack pointer
  // isn't in memory, so take each frame that starts a chain of frames running
  // unbroken up to there (stale frames below the live ones don't).
  for (let at = 0x0100; at < STACK_TOP && vars.length < 512; at++) {
    if (ram[at] !== TOK_FOR || !frameChain(ram, at)) continue;
    // The frame names its variable by the address of its value: name two bytes below.
    const value = word(ram, at + 1);
    if (value < b.vars + 2 || value + 5 > b.ary) continue;
    const { name } = varName(ram, value - 2);
    // STEP is held with an explicit leading 1 and its sign in a byte of its own.
    const step = formatC64Float(ram, at + 3);
    vars.push({
      name, kind: 'for-next', value: formatC64Float(ram, value),
      detail: `TO ${formatC64Float(ram, at + 9)} STEP ${ram[at + 8] >= 0x80 ? '-' : ''}${step.replace(/^-/, '')}`,
    });
    at += FOR_FRAME - 1;
  }
  return vars;
}
