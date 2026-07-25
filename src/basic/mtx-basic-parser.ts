/**
 * MTX BASIC listing parser.
 *
 * The MTX BASIC program lives at CPU 0x4000. Each line record is:
 *   [length word LE][line-number word LE][crunched tokens...][0xFF]
 * where `length` is the whole record's byte count (the link to the next line).
 * Keyword tokens are >= 0x80 (statements 0x80-0xC8, operators 0xC9-0xD9,
 * functions 0xDA-0xFD); every other byte is literal ASCII (digits, variable
 * letters, string contents, separators). MTX BASIC crunches spaces out on
 * entry, so LIST re-inserts them around statement keywords — which is what this
 * parser reproduces. Token tables are transcribed from the MTX BASIC ROM
 * keyword tables (basic.rom 0x53B statements, 0x680 functions).
 */

import type { BasicListingLine } from './types.ts';

const PROGRAM_START = 0x4000;
const LINE_TERMINATOR = 0xFF;
const REM = 0x80;
const MAX_LINES = 20000;

const STATEMENTS: Record<number, string> = {
  0x80: 'REM', 0x81: 'CLS', 0x82: 'ASSEM', 0x83: 'AUTO', 0x84: 'BAUD', 0x85: 'VS',
  0x86: 'CONT', 0x87: 'USER', 0x88: 'CRVS', 0x89: 'CLEAR', 0x8A: 'CLOCK', 0x8B: 'ATTR',
  0x8C: 'COLOUR', 0x8D: 'INK', 0x8E: 'CSR', 0x8F: 'DATA', 0x90: 'PRINT', 0x91: 'DIM',
  0x92: 'ADJSPR', 0x93: 'EDIT', 0x94: 'NEXT', 0x95: 'FOR', 0x96: 'GOTO', 0x97: 'GOSUB',
  0x98: 'INPUT', 0x99: 'IF', 0x9A: 'MVSPR', 0x9B: 'LIST', 0x9C: 'LET', 0x9D: 'LLIST',
  0x9E: 'LOAD', 0x9F: 'LPRINT', 0xA0: 'SPRITE', 0xA1: 'CTLSPR', 0xA2: 'NODE', 0xA3: 'NEW',
  0xA4: 'PAPER', 0xA5: 'NODDY', 0xA6: 'ON', 0xA7: 'OUT', 0xA8: 'PLOD', 0xA9: 'PANEL',
  0xAA: 'GENPAT', 0xAB: 'PAUSE', 0xAC: 'PHI', 0xAD: 'POKE', 0xAE: 'RAND', 0xAF: 'RETURN',
  0xB0: 'READ', 0xB1: 'VIEW', 0xB2: 'RESTORE', 0xB3: 'ROM', 0xB4: 'RUN', 0xB5: 'SAVE',
  0xB6: 'SOUND', 0xB7: 'EDITOR', 0xB8: 'DSI', 0xB9: 'PLOT', 0xBA: 'STOP', 0xBB: 'ANGLE',
  0xBC: 'SBUF', 0xBD: 'VERIFY', 0xBE: 'DRAW', 0xBF: 'ARC', 0xC0: 'CIRCLE', 0xC1: 'LINE',
  0xC2: 'CODE', 0xC3: 'ELSE', 0xC4: 'FK', 0xC5: 'OFF', 0xC6: 'STEP', 0xC7: 'THEN', 0xC8: 'TO',
};

const OPERATORS: Record<number, string> = {
  0xC9: 'I', 0xCA: 'J', 0xCB: 'K', 0xCC: 'L', 0xCD: 'M', 0xCE: 'N', 0xCF: '+', 0xD0: '-',
  0xD1: '*', 0xD2: '/', 0xD3: '^', 0xD4: '=', 0xD5: '>', 0xD6: '<', 0xD7: '>=', 0xD8: '<=',
  0xD9: '<>',
};

const FUNCTIONS: Record<number, string> = {
  0xDA: 'AND', 0xDB: 'OR', 0xDC: 'NOT', 0xDD: 'ABS', 0xDE: 'ATN', 0xDF: 'COS', 0xE0: 'EXP',
  0xE1: 'FRE', 0xE2: 'INT', 0xE3: 'INT', 0xE4: 'LN', 0xE5: 'PEEK', 0xE6: 'SGN', 0xE7: 'SIN',
  0xE8: 'SQR', 0xE9: 'TAN', 0xEA: 'INP', 0xEB: 'USR', 0xEC: 'LN', 0xED: 'ASC', 0xEE: 'LEN ',
  0xEF: 'VAL', 0xF0: 'LN', 0xF1: 'MOD', 0xF2: 'PI', 0xF3: 'RND', 0xF4: 'PI', 0xF5: 'CHR$',
  0xF6: 'SPK$', 0xF7: 'INKEY$', 0xF8: 'LEFT$', 0xF9: 'MID$', 0xFA: 'RIGHT$', 0xFB: 'GR$',
  0xFC: 'STR$', 0xFD: 'TIME$',
};

/** Word operators that read as infix and take surrounding spaces like keywords. */
const SPACED_FUNCTIONS = new Set(['AND', 'OR', 'NOT', 'MOD']);

const word = (m: Uint8Array, a: number): number => m[a] | (m[a + 1] << 8);

/** Append a keyword surrounded by single spaces, without doubling them. */
function appendKeyword(text: string, keyword: string): string {
  if (text.length > 0 && !text.endsWith(' ')) text += ' ';
  return `${text}${keyword} `;
}

function detokenizeLine(mem: Uint8Array, start: number, end: number): string {
  // REM makes the rest of the line a verbatim comment (spaces preserved).
  if (mem[start] === REM) {
    let comment = 'REM';
    for (let a = start + 1; a < end; a++) comment += String.fromCharCode(mem[a]);
    return comment.replace(/\s+$/, '');
  }

  let text = '';
  for (let a = start; a < end; a++) {
    const b = mem[a];
    if (b < 0x80) { text += String.fromCharCode(b); continue; }

    const statement = STATEMENTS[b];
    if (statement !== undefined) { text = appendKeyword(text, statement); continue; }

    const fn = FUNCTIONS[b];
    if (fn !== undefined) {
      // Word operators space out like keywords; ordinary functions stay inline
      // (their name — e.g. "LEN " — already carries any needed trailing space).
      text = SPACED_FUNCTIONS.has(fn) ? appendKeyword(text, fn) : text + fn;
      continue;
    }

    text += OPERATORS[b] ?? `{${b.toString(16).toUpperCase()}}`;
  }
  return text.replace(/\s+$/, '');
}

/** Parse the MTX BASIC program from a 64K CPU-address-space snapshot. */
export function parseMtxBasic(mem: Uint8Array): BasicListingLine[] {
  const lines: BasicListingLine[] = [];
  let pos = PROGRAM_START;
  for (let guard = 0; guard < MAX_LINES; guard++) {
    if (pos + 4 > mem.length) break;
    const link = word(mem, pos);
    // A record needs at least link(2) + line-number(2) + terminator(1); a link
    // below that (0 in particular) marks the end. The terminator check also
    // stops at stale bytes left in RAM past the real program end.
    if (link < 5) break;
    const recordEnd = pos + link;
    if (recordEnd > mem.length || mem[recordEnd - 1] !== LINE_TERMINATOR) break;
    lines.push({
      lineNumber: word(mem, pos + 2),
      text: detokenizeLine(mem, pos + 4, recordEnd - 1),
    });
    pos = recordEnd;
  }
  return lines;
}
