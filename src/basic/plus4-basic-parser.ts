/**
 * Commodore Plus/4 BASIC 3.5 listing parser.
 *
 * BASIC 3.5 is BASIC V2 with a longer keyword table: it keeps the same zero-page
 * pointers ($2B-$37), the same line layout (next-link, line number, tokens to a
 * zero byte) and the same variable and array tables, so only the token names
 * differ. The table below is the one in the BASIC 3.5 ROM
 * (`basic-318006-01.rom`, $818E upward): keywords from $80, ending at WHILE
 * ($FD), then a zero terminator. There are no $CE/$FE escape tokens — those are
 * BASIC 7.0 on the 128; in 3.5, $CC is RGR, $CD RCLR and $CE RLUM.
 *
 * Tokens are only decoded outside a quoted string and outside REM/DATA payload,
 * exactly as on the 64. $FF is pi.
 */

import type { BasicListingLine, BasicVariable } from './types.ts';
import { parseC64BasicVariables, petscii, word } from './c64-basic-parser.ts';

const TXTTAB = 0x2B;
const VARTAB = 0x2D;
const ARYTAB = 0x2F;
const STREND = 0x31;

const TOK_DATA = 0x83;
const TOK_REM = 0x8F;
const TOK_PI = 0xFF;

/** BASIC 3.5 keywords $80-$FD, in token order. */
const TOKENS: readonly string[] = [
  // The V2 set, unchanged.
  'END', 'FOR', 'NEXT', 'DATA', 'INPUT#', 'INPUT', 'DIM', 'READ', 'LET', 'GOTO', 'RUN', 'IF',
  'RESTORE', 'GOSUB', 'RETURN', 'REM', 'STOP', 'ON', 'WAIT', 'LOAD', 'SAVE', 'VERIFY', 'DEF',
  'POKE', 'PRINT#', 'PRINT', 'CONT', 'LIST', 'CLR', 'CMD', 'SYS', 'OPEN', 'CLOSE', 'GET', 'NEW',
  'TAB(', 'TO', 'FN', 'SPC(', 'THEN', 'NOT', 'STEP', '+', '-', '*', '/', '^', 'AND', 'OR', '>',
  '=', '<', 'SGN', 'INT', 'ABS', 'USR', 'FRE', 'POS', 'SQR', 'RND', 'LOG', 'EXP', 'COS', 'SIN',
  'TAN', 'ATN', 'PEEK', 'LEN', 'STR$', 'VAL', 'ASC', 'CHR$', 'LEFT$', 'RIGHT$', 'MID$', 'GO',
  // The 3.5 additions: the TED's graphics and sound, structured control, and
  // the disk commands.
  'RGR', 'RCLR', 'RLUM', 'JOY', 'RDOT', 'DEC', 'HEX$', 'ERR$', 'INSTR', 'ELSE', 'RESUME',
  'TRAP', 'TRON', 'TROFF', 'SOUND', 'VOL', 'AUTO', 'PUDEF', 'GRAPHIC', 'PAINT', 'CHAR', 'BOX',
  'CIRCLE', 'GSHAPE', 'SSHAPE', 'DRAW', 'LOCATE', 'COLOR', 'SCNCLR', 'SCALE', 'HELP', 'DO', 'LOOP',
  'EXIT', 'DIRECTORY', 'DSAVE', 'DLOAD', 'HEADER', 'SCRATCH', 'COLLECT', 'COPY', 'RENAME',
  'BACKUP', 'DELETE', 'RENUMBER', 'KEY', 'MONITOR', 'USING', 'UNTIL', 'WHILE',
];

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
function bounds(ram: Uint8Array): { txt: number; vars: number } | null {
  if (ram.length < 0x10000) return null;
  const txt = word(ram, TXTTAB);
  const vars = word(ram, VARTAB);
  const ary = word(ram, ARYTAB);
  const end = word(ram, STREND);
  if (txt < 0x0200 || txt > vars || vars > ary || ary > end || end > 0xA000) return null;
  return { txt, vars };
}

/** Parse the BASIC 3.5 program at TXTTAB from a 64K RAM image. */
export function parsePlus4Basic(ram: Uint8Array): BasicListingLine[] {
  const b = bounds(ram);
  if (!b || b.vars - b.txt < 2) return [];
  const lines: BasicListingLine[] = [];
  let addr = b.txt;
  for (let guard = 0; guard < 20000 && addr + 4 <= b.vars; guard++) {
    const next = word(ram, addr);
    if (next === 0) break;
    if (next <= addr + 4 || next > b.vars + 2) return lines;
    lines.push({ lineNumber: word(ram, addr + 2), text: detokenizeLine(ram, addr + 4, next - 1) });
    addr = next;
  }
  return lines;
}

/** BASIC 3.5's variable tables have the 64's layout, so its reader serves. */
export function parsePlus4BasicVariables(ram: Uint8Array): BasicVariable[] {
  return parseC64BasicVariables(ram);
}
