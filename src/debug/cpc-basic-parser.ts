/**
 * Locomotive BASIC (Amstrad CPC) detokenizer.
 *
 * Reads the tokenised BASIC program from the CPC's RAM and renders it as a
 * listing. The format and token values were verified against the real CPC 6128
 * firmware (OS6128 + BASIC 1.1) by typing programs and dumping memory:
 *
 *   Program text starts at &0170 in RAM (under the OS ROM overlay — read the
 *   underlying RAM, not the CPU-visible address space).
 *
 *   Each line:  LL LL  NN NN  <tokens…>  00
 *     LL LL = little-endian length of the whole record (incl. these 2 bytes,
 *             the line-number bytes, the tokens and the &00 terminator).
 *     NN NN = little-endian line number.
 *   End of program: a length word of &0000.
 *
 *   Value lead bytes inside a line (verified):
 *     &00            end of line
 *     &01            ':' statement separator
 *     &02 p p name   integer variable (suffix %)
 *     &03 p p name   string  variable (suffix $)
 *     &04 p p name   real    variable (suffix !)
 *     &0D p p name   real    variable (no suffix — the common case)
 *     &0E…&17        integer constant 0…9 (value = byte − &0E)
 *     &19 n          8-bit integer constant
 *     &1A n n        16-bit integer constant
 *     &1B n n        16-bit binary constant   (&X…)
 *     &1C n n        16-bit hex constant      (&…)
 *     &1D a a        line-number as a memory address (post-RUN GOTO target)
 *     &1E n n        line number (as typed)
 *     &1F m m m m e  5-byte floating-point constant
 *   Variable names: ASCII letters, the final byte has bit 7 set (`pp` is a
 *   2-byte runtime pointer, 0 before the program is run).
 *
 *   &20–&7F  printable ASCII (passes through; strings keep their " quotes).
 *   &80–&FF  keyword tokens (&FF = function prefix; the next byte selects it).
 */

/** Where Locomotive BASIC keeps the program text in RAM (fixed on 464/664/6128,
 *  unaffected by AMSDOS which reserves its workspace elsewhere). */
const PROG_START = 0x0170;

/** Main keyword tokens &80–&FF. Spaces are stored separately in the program as
 *  &20 bytes, so the keyword strings carry none of their own. */
const TOKENS: Record<number, string> = {
  0x80: 'AFTER', 0x81: 'AUTO', 0x82: 'BORDER', 0x83: 'CALL', 0x84: 'CAT',
  0x85: 'CHAIN', 0x86: 'CLEAR', 0x87: 'CLG', 0x88: 'CLOSEIN', 0x89: 'CLOSEOUT',
  0x8A: 'CLS', 0x8B: 'CONT', 0x8C: 'DATA', 0x8D: 'DEF', 0x8E: 'DEFINT',
  0x8F: 'DEFREAL', 0x90: 'DEFSTR', 0x91: 'DEG', 0x92: 'DELETE', 0x93: 'DIM',
  0x94: 'DRAW', 0x95: 'DRAWR', 0x96: 'EDIT', 0x97: 'ELSE', 0x98: 'END',
  0x99: 'ENT', 0x9A: 'ENV', 0x9B: 'ERASE', 0x9C: 'ERROR', 0x9D: 'EVERY',
  0x9E: 'FOR', 0x9F: 'GOSUB', 0xA0: 'GOTO', 0xA1: 'IF', 0xA2: 'INK',
  0xA3: 'INPUT', 0xA4: 'KEY', 0xA5: 'LET', 0xA6: 'LINE', 0xA7: 'LIST',
  0xA8: 'LOAD', 0xA9: 'LOCATE', 0xAA: 'MEMORY', 0xAB: 'MERGE', 0xAC: 'MID$',
  0xAD: 'MODE', 0xAE: 'MOVE', 0xAF: 'MOVER', 0xB0: 'NEXT', 0xB1: 'NEW',
  0xB2: 'ON', 0xB3: 'ON BREAK', 0xB4: 'ON ERROR GOTO 0', 0xB5: 'ON SQ',
  0xB6: 'OPENIN', 0xB7: 'OPENOUT', 0xB8: 'ORIGIN', 0xB9: 'OUT', 0xBA: 'PAPER',
  0xBB: 'PEN', 0xBC: 'PLOT', 0xBD: 'PLOTR', 0xBE: 'POKE', 0xBF: 'PRINT',
  0xC0: "'", 0xC1: 'RAD', 0xC2: 'RANDOMIZE', 0xC3: 'READ', 0xC4: 'RELEASE',
  0xC5: 'REM', 0xC6: 'RENUM', 0xC7: 'RESTORE', 0xC8: 'RESUME', 0xC9: 'RETURN',
  0xCA: 'RUN', 0xCB: 'SAVE', 0xCC: 'SOUND', 0xCD: 'SPEED', 0xCE: 'STOP',
  0xCF: 'SYMBOL', 0xD0: 'TAG', 0xD1: 'TAGOFF', 0xD2: 'TROFF', 0xD3: 'TRON',
  0xD4: 'WAIT', 0xD5: 'WEND', 0xD6: 'WHILE', 0xD7: 'WIDTH', 0xD8: 'WINDOW',
  0xD9: 'WRITE', 0xDA: 'ZONE', 0xDB: 'DI', 0xDC: 'EI', 0xDD: 'FILL',
  0xDE: 'GRAPHICS', 0xDF: 'MASK', 0xE0: 'FRAME', 0xE1: 'CURSOR', 0xE3: 'ERL',
  0xE4: 'FN', 0xE5: 'SPC', 0xE6: 'STEP', 0xE7: 'SWAP', 0xEA: 'TAB',
  0xEB: 'THEN', 0xEC: 'TO', 0xED: 'USING',
  0xEE: '>', 0xEF: '=', 0xF0: '>=', 0xF1: '<', 0xF2: '<>', 0xF3: '<=',
  0xF4: '+', 0xF5: '-', 0xF6: '*', 0xF7: '/', 0xF8: '^', 0xF9: '\\',
  0xFA: 'AND', 0xFB: 'MOD', 0xFC: 'OR', 0xFD: 'XOR', 0xFE: 'NOT',
};

/** Function tokens, reached via the &FF prefix byte. */
const FN_TOKENS: Record<number, string> = {
  0x00: 'ABS', 0x01: 'ASC', 0x02: 'ATN', 0x03: 'CHR$', 0x04: 'CINT',
  0x05: 'COS', 0x06: 'CREAL', 0x07: 'EXP', 0x08: 'FIX', 0x09: 'FRE',
  0x0A: 'INKEY', 0x0B: 'INP', 0x0C: 'INT', 0x0D: 'JOY', 0x0E: 'LEN',
  0x0F: 'LOG', 0x10: 'LOG10', 0x11: 'LOWER$', 0x12: 'PEEK', 0x13: 'REMAIN',
  0x14: 'SGN', 0x15: 'SIN', 0x16: 'SPACE$', 0x17: 'SQ', 0x18: 'SQR',
  0x19: 'STR$', 0x1A: 'TAN', 0x1B: 'UNT', 0x1C: 'UPPER$', 0x1D: 'VAL',
  0x40: 'EOF', 0x41: 'ERR', 0x42: 'HIMEM', 0x43: 'INKEY$', 0x44: 'PI',
  0x45: 'RND', 0x46: 'TIME', 0x47: 'XPOS', 0x48: 'YPOS', 0x49: 'DERR',
  0x71: 'BIN$', 0x72: 'DEC$', 0x73: 'HEX$', 0x74: 'INSTR', 0x75: 'LEFT$',
  0x76: 'MAX', 0x77: 'MIN', 0x78: 'POS', 0x79: 'RIGHT$', 0x7A: 'ROUND',
  0x7B: 'STRING$', 0x7C: 'TEST', 0x7D: 'TESTR', 0x7E: 'COPYCHR$', 0x7F: 'VPOS',
};

/** Variable lead byte → type suffix. */
const VAR_SUFFIX: Record<number, string> = {
  0x02: '%', 0x03: '$', 0x04: '!', 0x0B: '%', 0x0C: '$', 0x0D: '',
};

const word = (mem: Uint8Array, i: number): number => mem[i] | (mem[i + 1] << 8);

/** Decode a 5-byte Locomotive floating-point constant to a display string.
 *  Layout: 4 mantissa bytes (LE) + 1 exponent byte; the mantissa's top bit is
 *  the sign and the implicit leading 1 is restored. exp 0 ⇒ value 0. */
function decodeFloat(mem: Uint8Array, i: number): string {
  const exp = mem[i + 4];
  if (exp === 0) return '0';
  const b3 = mem[i + 3];
  const negative = (b3 & 0x80) !== 0;
  const mant = ((b3 | 0x80) * 0x1000000) + (mem[i + 2] * 0x10000) + (mem[i + 1] * 0x100) + mem[i];
  const value = (negative ? -1 : 1) * mant * Math.pow(2, exp - 128 - 32);
  // Trim to a tidy decimal without trailing float noise.
  return parseFloat(value.toPrecision(9)).toString();
}

/** Read a variable name (letters; the final byte has bit 7 set). Returns the
 *  name and the offset just past it. */
function readVarName(mem: Uint8Array, i: number, end: number): { name: string; next: number } {
  let name = '';
  while (i < end) {
    const c = mem[i++];
    name += String.fromCharCode(c & 0x7F);
    if (c & 0x80) break;
  }
  return { name, next: i };
}

/** Detokenize one line body (between the line number and the &00 terminator). */
function detokenizeLine(mem: Uint8Array, start: number, end: number): string {
  let out = '';
  let i = start;
  while (i < end) {
    const b = mem[i];

    if (b === 0x00) break;                       // end of line
    if (b === 0x01) { out += ':'; i++; continue; } // statement separator

    // Variables: lead byte + 2-byte runtime pointer + name + type suffix.
    if (b === 0x02 || b === 0x03 || b === 0x04 || b === 0x0B || b === 0x0C || b === 0x0D) {
      const r = readVarName(mem, i + 3, end);
      out += r.name + VAR_SUFFIX[b];
      i = r.next;
      continue;
    }

    // Integer constants 0–9 packed into the lead byte.
    if (b >= 0x0E && b <= 0x17) { out += String(b - 0x0E); i++; continue; }

    if (b === 0x19) { out += String(mem[i + 1]); i += 2; continue; }            // 8-bit int
    if (b === 0x1A) { out += String(word(mem, i + 1)); i += 3; continue; }      // 16-bit int
    if (b === 0x1B) { out += '&X' + word(mem, i + 1).toString(2); i += 3; continue; } // binary
    if (b === 0x1C) { out += '&' + word(mem, i + 1).toString(16).toUpperCase(); i += 3; continue; } // hex
    if (b === 0x1D) {                            // line ref stored as an address
      const addr = word(mem, i + 1);
      out += String(word(mem, addr + 2));        // line number lives at addr+2
      i += 3; continue;
    }
    if (b === 0x1E) { out += String(word(mem, i + 1)); i += 3; continue; }      // line number
    if (b === 0x1F) { out += decodeFloat(mem, i + 1); i += 6; continue; }       // float

    if (b >= 0x20 && b <= 0x7F) { out += String.fromCharCode(b); i++; continue; } // ASCII

    if (b === 0xFF) {                            // function (two-byte token)
      const fn = FN_TOKENS[mem[i + 1]];
      out += fn ?? `{FF ${mem[i + 1].toString(16)}}`;
      i += 2; continue;
    }

    if (b >= 0x80) { out += TOKENS[b] ?? `{${b.toString(16)}}`; i++; continue; } // keyword

    // Unknown control byte — skip it rather than corrupt the rest of the line.
    i++;
  }
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Parse a Locomotive BASIC program from a 64KB RAM snapshot (the underlying RAM,
 * not the ROM-overlaid CPU view — use `CpcMemory.ramSnapshot()`). Returns HTML.
 */
export function parseLocomotiveBasic(ram: Uint8Array): string {
  const lines: string[] = [];
  let offset = PROG_START;
  let guard = 0;

  while (offset + 4 <= ram.length && guard++ < 20000) {
    const len = word(ram, offset);
    if (len === 0) break;                         // &0000 length ⇒ end of program
    if (len < 4 || offset + len > ram.length) break;

    const lineNum = word(ram, offset + 2);
    const body = detokenizeLine(ram, offset + 4, offset + len - 1); // -1 skips the &00
    const numStr = String(lineNum).padStart(4, ' ');
    lines.push(`<span class="basic-line-num">${numStr}</span> ${escapeHtml(body)}`);

    offset += len;
  }

  if (lines.length === 0) return '<span style="color:#666">(no BASIC program)</span>';
  return lines.join('\n');
}
