/**
 * Commodore 128 BASIC V7.0 listing and variable-table parser.
 *
 * BASIC 7.0 splits its memory over the 128's two 64K blocks: the program text
 * lives in block 0 (from $1C01, or $4001 while a graphics area is reserved)
 * and everything it builds — simple variables, arrays and the string text —
 * in block 1, where the variables start at $0400. So unlike the 64's V2 the
 * end of the program isn't a pointer into the same bank: the listing is found
 * by following the line links to the terminating zero link.
 *
 *   TXTTAB $2D  start of the program (block 0)
 *   VARTAB $2F  start of the simple variables (block 1)
 *   ARYTAB $31  end of the simple variables = start of the arrays
 *   STREND $33  end of the arrays = bottom of free memory
 *   $7D         BASIC's run-time stack pointer (block 0)
 *
 * A program line, a variable and an array are laid out as on the 64: a
 * 7-byte variable entry (name, then five value bytes — a real is the same
 * 5-byte float, a string is its length and a block-1 pointer), arrays with
 * their dimensions big-endian, last subscript first.
 *
 * The FOR, GOSUB and DO frames are not on the 6502 stack: BASIC 7.0 keeps its
 * own, growing down to $09FF. A FOR frame is the 64's 18 bytes (token $81,
 * variable address, STEP, its sign, TO limit, line, text pointer); a GOSUB
 * frame is 5 bytes led by $8D and a DO frame 5 bytes led by $EB (token, line,
 * text pointer).
 *
 * The keyword table is the one in the BASIC ROM: single-byte tokens from $80,
 * and two escape tokens, $CE and $FE, each followed by a second byte.
 *
 * Every pointer is checked before anything is decoded: when the tables do not
 * hold together the parsers return nothing rather than garbage.
 */

import type { BasicListingLine, BasicVariable } from './types.ts';
import { formatC64Float, petscii, varName, word } from './c64-basic-parser.ts';

const TXTTAB = 0x2D;
const VARTAB = 0x2F;
const ARYTAB = 0x31;
const STREND = 0x33;
const STACK_PTR = 0x7D;

/** Block 1 starts here in the 128K image. */
const BLOCK1 = 0x10000;
/** Where BASIC's own FOR/GOSUB/DO stack ends (it grows down from here). */
const STACK_END = 0x09FF;
const STACK_FLOOR = 0x0900;

const TOK_FOR = 0x81;
const TOK_DATA = 0x83;
const TOK_REM = 0x8F;
const TOK_GOSUB = 0x8D;
const TOK_DO = 0xEB;
const TOK_ESC_CE = 0xCE;
const TOK_ESC_FE = 0xFE;
const TOK_PI = 0xFF;

const FOR_FRAME = 18;
const SMALL_FRAME = 5;

/** Tokens $80-$FD. An empty name is the $CE escape (and an unused slot). */
const TOKENS = [
  'END', 'FOR', 'NEXT', 'DATA', 'INPUT#', 'INPUT', 'DIM', 'READ', 'LET', 'GOTO', 'RUN', 'IF',
  'RESTORE', 'GOSUB', 'RETURN', 'REM', 'STOP', 'ON', 'WAIT', 'LOAD', 'SAVE', 'VERIFY', 'DEF',
  'POKE', 'PRINT#', 'PRINT', 'CONT', 'LIST', 'CLR', 'CMD', 'SYS', 'OPEN', 'CLOSE', 'GET', 'NEW',
  'TAB(', 'TO', 'FN', 'SPC(', 'THEN', 'NOT', 'STEP', '+', '-', '*', '/', '^', 'AND', 'OR', '>',
  '=', '<', 'SGN', 'INT', 'ABS', 'USR', 'FRE', 'POS', 'SQR', 'RND', 'LOG', 'EXP', 'COS', 'SIN',
  'TAN', 'ATN', 'PEEK', 'LEN', 'STR$', 'VAL', 'ASC', 'CHR$', 'LEFT$', 'RIGHT$', 'MID$', 'GO',
  'RGR', 'RCLR', '', 'JOY', 'RDOT', 'DEC', 'HEX$', 'ERR$', 'INSTR', 'ELSE', 'RESUME', 'TRAP',
  'TRON', 'TROFF', 'SOUND', 'VOL', 'AUTO', 'PUDEF', 'GRAPHIC', 'PAINT', 'CHAR', 'BOX', 'CIRCLE',
  'GSHAPE', 'SSHAPE', 'DRAW', 'LOCATE', 'COLOR', 'SCNCLR', 'SCALE', 'HELP', 'DO', 'LOOP', 'EXIT',
  'DIRECTORY', 'DSAVE', 'DLOAD', 'HEADER', 'SCRATCH', 'COLLECT', 'COPY', 'RENAME', 'BACKUP',
  'DELETE', 'RENUMBER', 'KEY', 'MONITOR', 'USING', 'UNTIL', 'WHILE',
];

/** The $CE escape: $CE02 upward. */
const TOKENS_CE = ['POT', 'BUMP', 'PEN', 'RSPPOS', 'RSPRITE', 'RSPCOLOR', 'XOR', 'RWINDOW', 'POINTER'];

/** The $FE escape: $FE02 upward. An empty name is an unused slot. */
const TOKENS_FE = [
  'BANK', 'FILTER', 'PLAY', 'TEMPO', 'MOVSPR', 'SPRITE', 'SPRCOLOR', 'RREG', 'ENVELOPE', 'SLEEP',
  'CATALOG', 'DOPEN', 'APPEND', 'DCLOSE', 'BSAVE', 'BLOAD', 'RECORD', 'CONCAT', 'DVERIFY',
  'DCLEAR', 'SPRSAV', 'COLLISION', 'BEGIN', 'BEND', 'WINDOW', 'BOOT', 'WIDTH', 'SPRDEF', 'QUIT',
  'STASH', '', 'FETCH', '', 'SWAP', 'OFF', 'FAST', 'SLOW',
];

const hexByte = (b: number): string => `{$${b.toString(16).padStart(2, '0')}}`;

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
    if ((b === TOK_ESC_CE || b === TOK_ESC_FE) && addr + 1 < end) {
      const second = mem[++addr];
      const name = (b === TOK_ESC_CE ? TOKENS_CE : TOKENS_FE)[second - 2];
      text += name || hexByte(b) + hexByte(second);
      continue;
    }
    if (b >= 0x80 && b < 0x80 + TOKENS.length && TOKENS[b - 0x80]) {
      text += TOKENS[b - 0x80];
      if (b === TOK_REM) literal = true;
      else if (b === TOK_DATA) { literal = true; toColon = true; }
      continue;
    }
    text += b >= 0x20 && b < 0x80 ? petscii(b) : hexByte(b);
  }
  return text;
}

/** The pointers, if they describe a believable program and variable area; else null. */
function bounds(ram: Uint8Array): { txt: number; vars: number; ary: number; end: number } | null {
  if (ram.length < 0x20000) return null;
  const txt = word(ram, TXTTAB);
  const vars = word(ram, VARTAB);
  const ary = word(ram, ARYTAB);
  const end = word(ram, STREND);
  if (txt < 0x0400 || txt >= 0xFF00) return null;
  if (vars < 0x0400 || vars > ary || ary > end || end > 0xFF00) return null;
  return { txt, vars, ary, end };
}

/** Parse the BASIC program at TXTTAB from a 128K RAM image (block 0 first). */
export function parseC128Basic(ram: Uint8Array): BasicListingLine[] {
  const b = bounds(ram);
  if (!b) return [];
  const lines: BasicListingLine[] = [];
  let addr = b.txt;
  for (let guard = 0; guard < 20000 && addr + 4 <= 0xFF00; guard++) {
    const next = word(ram, addr);
    if (next === 0) break;
    if (next <= addr + 4 || next > 0xFF00) return lines;
    // The body ends at its zero byte, which is the byte before the next link.
    lines.push({ lineNumber: word(ram, addr + 2), text: detokenizeLine(ram, addr + 4, next - 1) });
    addr = next;
  }
  return lines;
}

/** A string variable's text: its descriptor at `addr` (length, pointer into block 1). */
function stringValue(bank1: Uint8Array, addr: number): string {
  const len = bank1[addr];
  const ptr = word(bank1, addr + 1);
  if (len === 0 || ptr + len > 0x10000) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += petscii(bank1[ptr + i]);
  return s;
}

/** The FOR frames on BASIC's stack, newest first, if the stack chains from its pointer to its end; else none. */
function forFrames(ram: Uint8Array): number[] {
  const frames: number[] = [];
  let p = word(ram, STACK_PTR);
  if (p < STACK_FLOOR || p > STACK_END) return [];
  while (p < STACK_END) {
    const token = ram[p];
    if (token === TOK_FOR) { frames.push(p); p += FOR_FRAME; }
    else if (token === TOK_GOSUB || token === TOK_DO) p += SMALL_FRAME;
    else return [];
  }
  return p === STACK_END ? frames : [];
}

/** The simple variables, the arrays, and the FOR loops in progress. */
export function parseC128BasicVariables(ram: Uint8Array): BasicVariable[] {
  const b = bounds(ram);
  if (!b) return [];
  const vars: BasicVariable[] = [];
  // Entries are read through a block-1 view so the 64's helpers apply unchanged.
  const bank1 = ram.subarray(BLOCK1, BLOCK1 + 0x10000);

  for (let addr = b.vars; addr + 7 <= b.ary && vars.length < 512; addr += 7) {
    const { name, kind } = varName(bank1, addr);
    if (kind === 'fn') continue;
    if (kind === 'string') vars.push({ name, kind: 'string', value: stringValue(bank1, addr + 2) });
    else if (kind === 'int') {
      const v = (bank1[addr + 2] << 8) | bank1[addr + 3];
      vars.push({ name, kind: 'number', value: String(v >= 0x8000 ? v - 0x10000 : v) });
    } else vars.push({ name, kind: 'number', value: formatC64Float(bank1, addr + 2) });
  }

  for (let addr = b.ary; addr + 7 <= b.end && vars.length < 512;) {
    const { name, kind } = varName(bank1, addr);
    const next = addr + word(bank1, addr + 2);
    const dims = bank1[addr + 4];
    if (dims === 0 || next <= addr + 5 + dims * 2 || next > b.end) break;
    const extents: number[] = [];
    for (let d = 0; d < dims; d++) {
      const o = addr + 5 + d * 2;
      extents.push(Math.max(0, ((bank1[o] << 8) | bank1[o + 1]) - 1));
    }
    vars.push({ name: `${name}(${extents.reverse().join(',')})`, kind: 'array' });
    addr = next;
    if (kind === 'fn') break;
  }

  // FOR loops in progress, innermost first. A frame names its variable by the
  // address of its value: the name is two bytes below, in block 1.
  for (const frame of forFrames(ram)) {
    if (vars.length >= 512) break;
    const value = word(ram, frame + 1);
    if (value < b.vars + 2 || value + 5 > b.ary) continue;
    const { name } = varName(bank1, value - 2);
    // STEP is held with an explicit leading 1 and its sign in a byte of its own.
    const step = formatC64Float(ram, frame + 3);
    vars.push({
      name, kind: 'for-next', value: formatC64Float(bank1, value),
      detail: `TO ${formatC64Float(ram, frame + 9)} STEP ${ram[frame + 8] >= 0x80 ? '-' : ''}${step.replace(/^-/, '')}`,
    });
  }
  return vars;
}
