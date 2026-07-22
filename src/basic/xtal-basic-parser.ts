/**
 * Xtal BASIC listing parser (Tatung Einstein, xbas.com).
 *
 * Xtal BASIC is a disk-loaded interpreter (Crystal Research) — not a ROM BASIC —
 * so its format is undocumented publicly. The line-record layout and the token
 * table below were reverse-engineered from a running xbas.com RAM image; see
 * docs/superpowers/specs/2026-07-20-einstein-xtal-basic-listing-design.md.
 *
 * Line record: [u16 length LE][u16 lineNumber LE][body...][0x00], where length
 * counts the whole record (length word through terminator). End of program is a
 * length word of 0x0000. Numbers and line references are stored as plain ASCII
 * digits (no inline binary form), so a listing needs no float decoding.
 *
 * The interpreter keeps one contiguous keyword-string table; operators occupy
 * tokens 0x6F..0x7F and statements/functions 0x80..0xE9. Everything else is
 * literal text. Bytes inside a string literal or after REM are never
 * detokenised (lowercase letters overlap the operator token range).
 */

import type { BasicListingLine } from './types.ts';

/** Fixed program-text base in RAM (a 0x00 marker sits at PROG_START-1). */
const PROG_START = 0x3E01;

const TOKENS: Record<number, string> = {
  0x6F: 'SPC(', 0x70: 'STEP', 0x71: 'TAB(', 0x72: 'TO', 0x73: 'THEN',
  0x74: '+', 0x75: '-', 0x76: '^', 0x77: '*', 0x78: '/', 0x79: 'MOD',
  0x7A: 'AND', 0x7B: 'OR', 0x7C: 'XOR', 0x7D: '>', 0x7E: '=', 0x7F: '<',
  0x80: 'AUTO', 0x81: 'CHAIN', 0x82: 'CLEAR', 0x83: 'CLOSE', 0x84: 'CLS',
  0x85: 'CONT', 0x86: 'CREATE', 0x87: 'DATA', 0x88: 'DEF', 0x89: 'DEL',
  0x8A: 'DIM', 0x8B: 'DOKE', 0x8C: 'DRIVE', 0x8D: 'ELSE', 0x8E: 'END',
  0x8F: 'FOR', 0x90: 'GOSUB', 0x91: 'GOTO', 0x92: 'HOLD', 0x93: 'IF',
  0x94: 'INPUT', 0x95: 'LET', 0x96: 'LIST', 0x97: 'LOAD', 0x98: 'MGE',
  0x99: 'MOS', 0x9A: 'NEW', 0x9B: 'NEXT', 0x9C: 'OFF', 0x9D: 'ON',
  0x9E: 'OPEN', 0x9F: 'OUT', 0xA0: 'POKE', 0xA1: 'POP', 0xA2: 'PRINT',
  0xA3: 'READ', 0xA4: 'REM', 0xA5: 'RENUM', 0xA6: 'UNPLOT', 0xA7: 'RESTORE',
  0xA8: 'RETURN', 0xA9: 'RUN', 0xAA: 'SAVE', 0xAB: 'PLOT', 0xAC: 'STOP',
  0xAD: 'SWAP', 0xAE: 'VERIFY', 0xAF: 'WAIT', 0xB0: 'FMT', 0xB1: 'APPEND',
  0xB2: 'DIR', 0xB3: 'ERA', 0xB4: 'LOCK', 0xB5: 'REN', 0xB6: 'UNLOCK',
  0xB7: 'MUSIC', 0xB8: 'CALL', 0xB9: 'IOM', 0xBA: 'NULL', 0xBB: 'PTR',
  0xBC: 'SEP', 0xBD: 'SPEED', 0xBE: 'WIDTH', 0xBF: 'ZONE', 0xC0: 'TI$',
  0xC1: 'TEMPO', 0xC2: 'VOICE', 0xC3: 'PSG', 0xC4: 'ABS', 0xC5: 'ASC',
  0xC6: 'ATN', 0xC7: 'CHR$', 0xC8: 'COS', 0xC9: 'DEEK', 0xCA: 'EVAL',
  0xCB: 'EXP', 0xCC: 'HEX$', 0xCD: 'INP', 0xCE: 'INT', 0xCF: 'LEN',
  0xD0: 'LN', 0xD1: 'LOG', 0xD2: 'PEEK', 0xD3: 'POINT', 0xD4: 'POS',
  0xD5: 'RND', 0xD6: 'SCRN$', 0xD7: 'SGN', 0xD8: 'SIN', 0xD9: 'SQR',
  0xDA: 'STR$', 0xDB: 'TAN', 0xDC: 'VAL', 0xDD: 'LEFT$', 0xDE: 'MID$',
  0xDF: 'RIGHT$', 0xE0: 'ERR', 0xE1: 'ERL', 0xE2: 'EOF', 0xE3: 'FN',
  0xE4: 'INCH', 0xE5: 'KBD', 0xE6: 'MUL$', 0xE7: 'NOT', 0xE8: 'PI',
  0xE9: 'SIZE',
};

const REM_TOKEN = 0xA4;
/** First token value; below this every byte is literal program text. */
const FIRST_TOKEN = 0x6F;

const word = (mem: Uint8Array, addr: number): number =>
  mem[addr] | (mem[addr + 1] << 8);

function detokenize(mem: Uint8Array, start: number, end: number): string {
  let text = '';
  let inString = false;
  let inRem = false;
  for (let i = start; i < end; i++) {
    const b = mem[i];
    if (inRem || inString) {
      text += String.fromCharCode(b);
      if (inString && b === 0x22) inString = false;
      continue;
    }
    if (b === 0x22) { inString = true; text += '"'; continue; }
    const token = TOKENS[b];
    if (token !== undefined) {
      text += token;
      if (b === REM_TOKEN) inRem = true;
      continue;
    }
    if (b >= FIRST_TOKEN) {
      // A token byte with no table entry (e.g. an extended graphics keyword
      // reached through a lead-byte prefix, not yet mapped). Never drop it.
      text += `{${b.toString(16).toUpperCase().padStart(2, '0')}}`;
      continue;
    }
    text += String.fromCharCode(b);
  }
  return text;
}

/**
 * Parse an Xtal BASIC program out of a RAM snapshot. Returns the detokenised
 * listing, or `[]` when RAM does not hold a structurally valid program (the
 * "not in BASIC" signal).
 */
export function parseXtalBasic(mem: Uint8Array): BasicListingLine[] {
  const out: BasicListingLine[] = [];
  let addr = PROG_START;
  let guard = 0;
  while (addr + 4 <= mem.length && guard++ < 20000) {
    const length = word(mem, addr);
    if (length === 0) break;                      // end-of-program marker
    if (length < 5 || addr + length > mem.length) break; // structural bail
    const lineNumber = word(mem, addr + 2);
    if (lineNumber > 65529) break;
    out.push({
      lineNumber,
      text: detokenize(mem, addr + 4, addr + length - 1),
    });
    addr += length;
  }
  return out;
}
