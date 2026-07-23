/**
 * MSX BASIC 1.0 listing and variable-table parser.
 *
 * The HX-10's MSX BASIC is Microsoft BASIC 4.5. Its program and variable
 * bounds are stored in the documented BASIC work area in main RAM.
 * Reference: https://www.msx.org/wiki/Internal_Structure_Of_BASIC_listing
 * and https://www.msx.org/wiki/System_variables_and_work_area
 */

import type { BasicListingLine, BasicVariable } from './types.ts';

const TXTTAB = 0xF676;
const VARTAB = 0xF6C2;
const ARYTAB = 0xF6C4;
const STREND = 0xF6C6;

const TOKENS: Record<number, string> = {
  0x81: 'END', 0x82: 'FOR', 0x83: 'NEXT', 0x84: 'DATA', 0x85: 'INPUT', 0x86: 'DIM',
  0x87: 'READ', 0x88: 'LET', 0x89: 'GOTO', 0x8A: 'RUN', 0x8B: 'IF', 0x8C: 'RESTORE',
  0x8D: 'GOSUB', 0x8E: 'RETURN', 0x8F: 'REM', 0x90: 'STOP', 0x91: 'PRINT',
  0x92: 'CLEAR', 0x93: 'LIST', 0x94: 'NEW', 0x95: 'ON', 0x96: 'WAIT', 0x97: 'DEF',
  0x98: 'POKE', 0x99: 'CONT', 0x9A: 'CSAVE', 0x9B: 'CLOAD', 0x9C: 'OUT',
  0x9D: 'LPRINT', 0x9E: 'LLIST', 0x9F: 'CLS', 0xA0: 'WIDTH', 0xA2: 'TRON',
  0xA3: 'TROFF', 0xA4: 'SWAP', 0xA5: 'ERASE', 0xA6: 'ERROR', 0xA7: 'RESUME',
  0xA8: 'DELETE', 0xA9: 'AUTO', 0xAA: 'RENUM', 0xAB: 'DEFSTR', 0xAC: 'DEFINT',
  0xAD: 'DEFSNG', 0xAE: 'DEFDBL', 0xAF: 'LINE', 0xB0: 'OPEN', 0xB1: 'FIELD',
  0xB2: 'GET', 0xB3: 'PUT', 0xB4: 'CLOSE', 0xB5: 'LOAD', 0xB6: 'MERGE',
  0xB7: 'FILES', 0xB8: 'LSET', 0xB9: 'RSET', 0xBA: 'SAVE', 0xBB: 'LFILES',
  0xBC: 'CIRCLE', 0xBD: 'COLOR', 0xBE: 'DRAW', 0xBF: 'PAINT', 0xC0: 'BEEP',
  0xC1: 'PLAY', 0xC2: 'PSET', 0xC3: 'PRESET', 0xC4: 'SOUND', 0xC5: 'SCREEN',
  0xC6: 'VPOKE', 0xC7: 'SPRITE', 0xC8: 'VDP', 0xC9: 'BASE', 0xCA: 'CALL',
  0xCB: 'TIME', 0xCC: 'KEY', 0xCD: 'MAX', 0xCE: 'MOTOR', 0xCF: 'BLOAD',
  0xD0: 'BSAVE', 0xD1: 'DSKO$', 0xD2: 'SET', 0xD3: 'NAME', 0xD4: 'KILL',
  0xD5: 'IPL', 0xD6: 'COPY', 0xD7: 'CMD', 0xD8: 'LOCATE', 0xD9: 'TO',
  0xDA: 'THEN', 0xDB: 'TAB(', 0xDC: 'STEP', 0xDD: 'USR', 0xDE: 'FN',
  0xDF: 'SPC(', 0xE0: 'NOT', 0xE1: 'ERL', 0xE2: 'ERR', 0xE3: 'STRING$',
  0xE4: 'USING', 0xE5: 'INSTR', 0xE6: "'", 0xE7: 'VARPTR', 0xE8: 'CSRLIN',
  0xE9: 'ATTR$', 0xEA: 'DSKI$', 0xEB: 'OFF', 0xEC: 'INKEY$', 0xED: 'POINT',
  0xEE: '>', 0xEF: '=', 0xF0: '<', 0xF1: '+', 0xF2: '-', 0xF3: '*', 0xF4: '/',
  0xF5: '^', 0xF6: 'AND', 0xF7: 'OR', 0xF8: 'XOR', 0xF9: 'EQV', 0xFA: 'IMP',
  0xFB: 'MOD', 0xFC: '\\',
};

const FUNCTION_TOKENS: Record<number, string> = {
  0x81: 'LEFT$', 0x82: 'RIGHT$', 0x83: 'MID$', 0x84: 'SGN', 0x85: 'INT',
  0x86: 'ABS', 0x87: 'SQR', 0x88: 'RND', 0x89: 'SIN', 0x8A: 'LOG',
  0x8B: 'EXP', 0x8C: 'COS', 0x8D: 'TAN', 0x8E: 'ATN', 0x8F: 'FRE',
  0x90: 'INP', 0x91: 'POS', 0x92: 'LEN', 0x93: 'STR$', 0x94: 'VAL',
  0x95: 'ASC', 0x96: 'CHR$', 0x97: 'PEEK', 0x98: 'VPEEK', 0x99: 'SPACE$',
  0x9A: 'OCT$', 0x9B: 'HEX$', 0x9C: 'LPOS', 0x9D: 'BIN$', 0x9E: 'CINT',
  0x9F: 'CSNG', 0xA0: 'CDBL', 0xA1: 'FIX', 0xA2: 'STICK', 0xA3: 'STRIG',
  0xA4: 'PDL', 0xA5: 'PAD', 0xA6: 'DSKF', 0xA7: 'FPOS', 0xA8: 'CVI',
  0xA9: 'CVS', 0xAA: 'CVD', 0xAB: 'EOF', 0xAC: 'LOC', 0xAD: 'LOF',
  0xAE: 'MKI$', 0xAF: 'MKS$', 0xB0: 'MKD$',
};

const word = (mem: Uint8Array, addr: number): number => mem[addr] | (mem[addr + 1] << 8);

function signedWord(mem: Uint8Array, addr: number): number {
  const value = word(mem, addr);
  return value >= 0x8000 ? value - 0x10000 : value;
}

/** Decode MSX BASIC's packed-BCD single/double format without binary rounding. */
function decodeBcdFloat(mem: Uint8Array, addr: number, size: 4 | 8): string {
  const header = mem[addr];
  if (header === 0) return '0';

  let digits = '';
  for (let i = 1; i < size; i++) {
    digits += ((mem[addr + i] >> 4) & 0x0F).toString();
    digits += (mem[addr + i] & 0x0F).toString();
  }
  digits = digits.replace(/0+$/, '') || '0';
  const exponent = (header & 0x7F) - 65;
  const negative = (header & 0x80) !== 0;

  // The mantissa has one digit before the decimal point. Keep ordinary values
  // ordinary, but retain exponential notation for the extreme ranges BASIC uses.
  let value: string;
  if (exponent >= -5 && exponent <= 8) {
    const point = exponent + 1;
    if (point <= 0) value = `0.${'0'.repeat(-point)}${digits}`;
    else if (point >= digits.length) value = digits + '0'.repeat(point - digits.length);
    else value = `${digits.slice(0, point)}.${digits.slice(point)}`;
  } else {
    value = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
    value += `E${exponent >= 0 ? '+' : ''}${exponent}`;
  }
  return negative ? `-${value}` : value;
}

function detokenizeLine(mem: Uint8Array, start: number, end: number): string {
  let text = '';
  let quoted = false;
  for (let addr = start; addr < end; addr++) {
    const b = mem[addr];
    // ELSE and apostrophe are encoded as colon-prefixed compound tokens.
    if (!quoted && b === 0x3A && mem[addr + 1] === 0xA1) { text += 'ELSE'; addr++; continue; }
    if (!quoted && b === 0x3A && mem[addr + 1] === 0x8F && mem[addr + 2] === 0xE6) { text += "'"; addr += 2; continue; }
    if (b === 0x22) quoted = !quoted;
    if (quoted || b >= 0x20 && b < 0x80) { text += String.fromCharCode(b); continue; }

    if (b >= 0x11 && b <= 0x1A) { text += String(b - 0x11); continue; }
    if (b === 0x0F && addr + 1 < end) { text += String(mem[++addr]); continue; }
    if (b === 0x1C && addr + 2 < end) { text += String(signedWord(mem, addr + 1)); addr += 2; continue; }
    if (b === 0x0B && addr + 2 < end) { text += `&O${word(mem, addr + 1).toString(8)}`; addr += 2; continue; }
    if (b === 0x0C && addr + 2 < end) { text += `&H${word(mem, addr + 1).toString(16).toUpperCase()}`; addr += 2; continue; }
    if (b === 0x0E && addr + 2 < end) { text += String(word(mem, addr + 1)); addr += 2; continue; }
    if (b === 0x0D && addr + 2 < end) {
      const line = word(mem, addr + 1);
      text += line + 3 < mem.length ? String(word(mem, line + 2)) : '?';
      addr += 2;
      continue;
    }
    if (b === 0x1D && addr + 4 < end) { text += decodeBcdFloat(mem, addr + 1, 4); addr += 4; continue; }
    if (b === 0x1F && addr + 8 < end) { text += decodeBcdFloat(mem, addr + 1, 8); addr += 8; continue; }
    if (b === 0xFF && addr + 1 < end) { text += FUNCTION_TOKENS[mem[++addr]] ?? '{FF}'; continue; }
    text += TOKENS[b] ?? `{${b.toString(16).toUpperCase()}}`;
  }
  return text;
}

/** Follow one MSX BASIC linked-list representation from its first line record. */
function parseListingAt(ram: Uint8Array, start: number, end: number): BasicListingLine[] {
  if (start + 4 > end) return [];
  const lines: BasicListingLine[] = [];
  let addr = start;
  let guard = 0;
  while (addr + 4 <= end && guard++ < 20000) {
    const next = word(ram, addr);
    if (next === 0) {
      let end = addr + 4;
      while (end < ram.length && ram[end] !== 0) end++;
      // A zero-link sentinel immediately before VARTAB has no line number/body.
      if (end >= ram.length || word(ram, addr + 2) === 0) break;
      lines.push({ lineNumber: word(ram, addr + 2), text: detokenizeLine(ram, addr + 4, end) });
      break;
    }
    if (next <= addr || next > end || ram[next - 1] !== 0) return [];
    lines.push({ lineNumber: word(ram, addr + 2), text: detokenizeLine(ram, addr + 4, next - 1) });
    addr = next;
  }
  return lines;
}

/** Find a line terminator without mistaking zero bytes inside encoded constants for one. */
function lineEnd(ram: Uint8Array, start: number, end: number): number {
  let quoted = false;
  for (let addr = start; addr < end; addr++) {
    const b = ram[addr];
    if (b === 0x22) quoted = !quoted;
    if (quoted) continue;
    if (b === 0) return addr;
    if (b === 0x0B || b === 0x0C || b === 0x0D || b === 0x0E || b === 0x1C) addr += 2;
    else if (b === 0x0F || b === 0xFF) addr++;
    else if (b === 0x1D) addr += 4;
    else if (b === 0x1F) addr += 8;
  }
  return -1;
}

/**
 * Read line records back-to-back. BASIC's loader may not have rebuilt its line
 * links yet while a tape/disk load is in progress, but VARTAB still bounds the
 * token stream and every record retains its line-number header.
 */
function parseSequentialListing(ram: Uint8Array, start: number, end: number): BasicListingLine[] {
  const lines: BasicListingLine[] = [];
  let addr = start;
  let guard = 0;
  while (addr + 4 <= end && guard++ < 20000) {
    const link = word(ram, addr);
    const number = word(ram, addr + 2);
    if (link === 0 && number === 0) break;
    const bodyEnd = lineEnd(ram, addr + 4, end);
    if (bodyEnd < 0) return [];
    lines.push({ lineNumber: number, text: detokenizeLine(ram, addr + 4, bodyEnd) });
    addr = bodyEnd + 1;
  }
  return lines;
}

/** Parse MSX BASIC's linked program records from an underlying RAM snapshot. */
export function parseMsxBasic(ram: Uint8Array): BasicListingLine[] {
  if (ram.length < STREND + 2) return [];
  const program = word(ram, TXTTAB);
  const vartab = word(ram, VARTAB);
  if (program + 4 > vartab || vartab > ram.length) return [];

  // MSX BASIC images differ on whether TXTTAB points to the initial zero marker
  // or directly to the first line's link word. The real interpreter accepts both
  // during load/relink; accepting both here keeps the pane useful mid-load too.
  const starts = ram[program] === 0 ? [program + 1, program] : [program, program + 1];
  for (const start of starts) {
    const lines = parseListingAt(ram, start, vartab);
    if (lines.length > 0) return lines;
  }
  for (const start of starts) {
    const lines = parseSequentialListing(ram, start, vartab);
    if (lines.length > 0) return lines;
  }
  return [];
}

const TYPE_INFO: Record<number, { suffix: string; size: 2 | 3 | 4 | 8 }> = {
  0x02: { suffix: '%', size: 2 },
  0x03: { suffix: '$', size: 3 },
  0x04: { suffix: '', size: 4 },
  0x08: { suffix: '#', size: 8 },
};

function variableName(ram: Uint8Array, addr: number, suffix: string): string {
  const first = String.fromCharCode(ram[addr] & 0x7F);
  const second = ram[addr + 1] ? String.fromCharCode(ram[addr + 1] & 0x7F) : '';
  return first + second + suffix;
}

function readValue(ram: Uint8Array, addr: number, type: number): string {
  if (type === 0x02) return String(signedWord(ram, addr));
  if (type === 0x03) {
    const len = ram[addr];
    const start = word(ram, addr + 1);
    if (start + len > ram.length) return '';
    return String.fromCharCode(...ram.subarray(start, start + len));
  }
  return decodeBcdFloat(ram, addr, type === 0x08 ? 8 : 4);
}

/** Parse MSX BASIC's simple variables and arrays from an underlying RAM snapshot. */
export function parseMsxBasicVariables(ram: Uint8Array): BasicVariable[] {
  if (ram.length < STREND + 2) return [];
  const vartab = word(ram, VARTAB);
  const arytab = word(ram, ARYTAB);
  const strend = word(ram, STREND);
  if (vartab > arytab || arytab > strend || strend > ram.length) return [];

  const vars: BasicVariable[] = [];
  let addr = vartab;
  while (addr + 3 <= arytab) {
    const type = ram[addr];
    const info = TYPE_INFO[type];
    if (!info || addr + 3 + info.size > arytab) return vars;
    vars.push({ name: variableName(ram, addr + 1, info.suffix), kind: type === 0x03 ? 'string' : 'number', value: readValue(ram, addr + 3, type) });
    addr += 3 + info.size;
  }

  addr = arytab;
  while (addr + 6 <= strend) {
    const type = ram[addr];
    const info = TYPE_INFO[type];
    if (!info) return vars;
    const payload = word(ram, addr + 3);
    const payloadStart = addr + 5;
    if (payload < 1 || payloadStart + payload > strend) return vars;
    const dims = ram[payloadStart];
    if (payload < 1 + dims * 2) return vars;
    const extents: number[] = [];
    for (let i = 0; i < dims; i++) extents.push(Math.max(0, word(ram, payloadStart + 1 + i * 2) - 1));
    vars.push({ name: `${variableName(ram, addr + 1, info.suffix)}(${extents.reverse().join(',')})`, kind: 'array' });
    addr = payloadStart + payload;
  }
  return vars;
}
