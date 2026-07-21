import type { BasicListingLine, BasicVariable } from '@/basic/types.ts';
import type { Zx8xModel } from './models.ts';

const ZX81_TOKENS = [
  '""', 'AT', 'TAB', '?', 'CODE', 'VAL', 'LEN', 'SIN', 'COS', 'TAN', 'ASN', 'ACS', 'ATN', 'LN', 'EXP', 'INT',
  'SQR', 'SGN', 'ABS', 'PEEK', 'USR', 'STR$', 'CHR$', 'NOT', '**', 'OR', 'AND', '<=', '>=', '<>', 'THEN', 'TO',
  'STEP', 'LPRINT', 'LLIST', 'STOP', 'SLOW', 'FAST', 'NEW', 'SCROLL', 'CONT', 'DIM', 'REM', 'FOR', 'GOTO', 'GOSUB',
  'INPUT', 'LOAD', 'LIST', 'LET', 'PAUSE', 'NEXT', 'POKE', 'PRINT', 'PLOT', 'RUN', 'SAVE', 'RAND', 'IF', 'CLS',
  'UNPLOT', 'CLEAR', 'RETURN', 'COPY',
] as const;

const ZX80_TOKENS = [
  '"', 'THEN', 'TO', ';', ',', ')', '(', 'NOT', '-', '+', '*', '/', 'AND', 'OR', '**', '=', '<', '>', 'LIST',
  'RETURN', 'CLS', 'DIM', 'SAVE', 'FOR', 'GO TO', 'POKE', 'INPUT', 'RANDOMISE', 'LET', '?', '?', 'NEXT', 'PRINT',
  '?', 'NEW', 'RUN', 'STOP', 'CONTINUE', 'IF', 'GO SUB', 'LOAD', 'CLEAR', 'REM', '?',
] as const;

const ZX81_CHARS = '           "£$:?()><=+-*/;,.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ZX80_CHARS = ' "          £$:?()-+*/=><;,.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function read16(mem: Uint8Array, address: number): number {
  return mem[address] | (mem[address + 1] << 8);
}

/** Convert a native ZX80/ZX81 character code to a readable Unicode glyph. */
export function zx8xChar(model: Zx8xModel, value: number): string {
  const code = value & 0x3f;
  const table = model === 'zx80' ? ZX80_CHARS : ZX81_CHARS;
  return table[code] ?? ' ';
}

function token(model: Zx8xModel, value: number): string | null {
  if (model === 'zx80') return value >= 0xd4 ? ZX80_TOKENS[value - 0xd4] ?? '?' : null;
  return value >= 0xc0 ? ZX81_TOKENS[value - 0xc0] ?? '?' : null;
}

function appendWord(result: string, value: string): string {
  if (!/^[A-Z]/.test(value)) return result + value;
  const prefix = result.length > 0 && !/[\s(]$/.test(result) ? ' ' : '';
  return `${result}${prefix}${value} `;
}

function detokenize(mem: Uint8Array, model: Zx8xModel, start: number, end: number): string {
  let result = '';
  for (let offset = start; offset < end; offset++) {
    const value = mem[offset];
    if (value === 0x76) break;
    if (model === 'zx81' && value === 0x7e) {
      offset += 5; // textual number is followed by its five-byte binary value
      continue;
    }
    const keyword = token(model, value);
    if (keyword !== null) result = appendWord(result, keyword);
    else result += zx8xChar(model, value);
  }
  return result.trim();
}

export function parseZx8xBasicProgram(mem: Uint8Array, model: Zx8xModel): BasicListingLine[] {
  const start = model === 'zx80' ? 0x4028 : 0x407d;
  const end = model === 'zx80' ? read16(mem, 0x4008) : read16(mem, 0x400c);
  if (end <= start || end > 0x8000) return [];

  const lines: BasicListingLine[] = [];
  let offset = start;
  while (offset + 2 < end && lines.length < 10000) {
    const high = mem[offset];
    if ((high & 0xc0) !== 0) break;
    const lineNumber = (high << 8) | mem[offset + 1];
    if (model === 'zx81') {
      if (offset + 4 > end) break;
      const length = read16(mem, offset + 2);
      const next = offset + 4 + length;
      if (length === 0 || next > end) break;
      lines.push({ lineNumber, text: detokenize(mem, model, offset + 4, next) });
      offset = next;
    } else {
      let next = offset + 2;
      while (next < end && mem[next] !== 0x76) next++;
      if (next >= end) break;
      lines.push({ lineNumber, text: detokenize(mem, model, offset + 2, next) });
      offset = next + 1;
    }
  }
  return lines;
}

function zx81Number(mem: Uint8Array, offset: number): string {
  const exp = mem[offset], b1 = mem[offset + 1], b2 = mem[offset + 2], b3 = mem[offset + 3], b4 = mem[offset + 4];
  if (exp === 0 && b4 === 0 && (b1 === 0 || b1 === 0xff)) {
    let value = b2 | (b3 << 8);
    if (b1 === 0xff) value -= 0x10000;
    return value.toString();
  }
  const sign = (b1 & 0x80) ? -1 : 1;
  const mantissa = (b1 | 0x80) * 0x1000000 + b2 * 0x10000 + b3 * 0x100 + b4;
  return (sign * mantissa * Math.pow(2, exp - 160)).toString();
}

function zx80Integer(mem: Uint8Array, offset: number): string {
  const unsigned = read16(mem, offset);
  return (unsigned & 0x8000 ? unsigned - 0x10000 : unsigned).toString();
}

function variableLetter(model: Zx8xModel, value: number): string {
  return zx8xChar(model, (value & 0x1f) | 0x20);
}

function decodeChars(mem: Uint8Array, model: Zx8xModel, start: number, end: number): string {
  let result = '';
  for (let i = start; i < end; i++) result += zx8xChar(model, mem[i]);
  return result;
}

function arrayDims(mem: Uint8Array, start: number, length: number, end: number): number[] {
  if (length < 1 || start >= end) return [];
  const count = mem[start];
  if (count === 0 || 1 + count * 2 > length) return [];
  const dims: number[] = [];
  for (let i = 0; i < count; i++) dims.push(read16(mem, start + 1 + i * 2));
  return dims;
}

function parseZx81Variables(mem: Uint8Array): BasicVariable[] {
  const start = read16(mem, 0x4010), end = read16(mem, 0x4014);
  if (start < 0x4000 || end <= start || end > 0x8000) return [];
  const result: BasicVariable[] = [];
  let offset = start;
  while (offset < end && result.length < 1000) {
    const first = mem[offset];
    if (first === 0x80) break;
    const type = first & 0xe0;
    const base = variableLetter('zx81', first);
    if (type === 0x60 && offset + 6 <= end) {
      result.push({ name: base, kind: 'number', value: zx81Number(mem, offset + 1) }); offset += 6;
    } else if (type === 0x40 && offset + 3 <= end) {
      const length = read16(mem, offset + 1);
      if (offset + 3 + length > end) break;
      result.push({ name: `${base}$`, kind: 'string', value: decodeChars(mem, 'zx81', offset + 3, offset + 3 + length) });
      offset += 3 + length;
    } else if ((type === 0x80 || type === 0xc0) && offset + 3 <= end) {
      const length = read16(mem, offset + 1);
      if (offset + 3 + length > end) break;
      const dims = arrayDims(mem, offset + 3, length, end);
      result.push({ name: `${base}${type === 0xc0 ? '$' : ''}(${dims.join(',')})`, kind: 'array' });
      offset += 3 + length;
    } else if (type === 0xa0) {
      let name = base, pos = offset + 1;
      while (pos < end) {
        const value = mem[pos++];
        name += zx8xChar('zx81', value);
        if (value & 0x80) break;
      }
      if (pos + 5 > end) break;
      result.push({ name, kind: 'number', value: zx81Number(mem, pos) }); offset = pos + 5;
    } else if (type === 0xe0 && offset + 19 <= end) {
      result.push({ name: base, kind: 'for-next', value: zx81Number(mem, offset + 1), detail: `TO ${zx81Number(mem, offset + 6)} STEP ${zx81Number(mem, offset + 11)}` });
      offset += 19;
    } else break;
  }
  return result;
}

function parseZx80Variables(mem: Uint8Array): BasicVariable[] {
  const start = read16(mem, 0x4008), end = read16(mem, 0x400a);
  if (start < 0x4000 || end <= start || end > 0x8000) return [];
  const result: BasicVariable[] = [];
  let offset = start;
  while (offset < end && result.length < 1000) {
    const first = mem[offset];
    if (first === 0x80) break;
    const type = first & 0xe0;
    const base = variableLetter('zx80', first);
    if (type === 0x60 && offset + 3 <= end) {
      result.push({ name: base, kind: 'number', value: zx80Integer(mem, offset + 1) }); offset += 3;
    } else if (type === 0x40) {
      let name = base, pos = offset + 1;
      while (pos < end) {
        const value = mem[pos++];
        name += zx8xChar('zx80', value);
        if (value & 0x80) break;
      }
      if (pos + 2 > end) break;
      result.push({ name, kind: 'number', value: zx80Integer(mem, pos) }); offset = pos + 2;
    } else if (type === 0x80) {
      let pos = offset + 1;
      while (pos < end && mem[pos] !== 0x01) pos++;
      if (pos >= end) break;
      result.push({ name: `${base}$`, kind: 'string', value: decodeChars(mem, 'zx80', offset + 1, pos) }); offset = pos + 1;
    } else if (type === 0xa0 && offset + 2 <= end) {
      const max = mem[offset + 1];
      const next = offset + 2 + (max + 1) * 2;
      if (next > end) break;
      result.push({ name: `${base}(${max})`, kind: 'array' }); offset = next;
    } else if (type === 0xe0 && offset + 7 <= end) {
      result.push({ name: base, kind: 'for-next', value: zx80Integer(mem, offset + 1), detail: `TO ${zx80Integer(mem, offset + 3)}` }); offset += 7;
    } else break;
  }
  return result;
}

export function parseZx8xBasicVariables(mem: Uint8Array, model: Zx8xModel): BasicVariable[] {
  return model === 'zx80' ? parseZx80Variables(mem) : parseZx81Variables(mem);
}
