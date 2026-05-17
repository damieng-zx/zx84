/**
 * ZX Spectrum BASIC parser and detokenizer.
 * Reads tokenized BASIC from memory and converts to readable text.
 * Reference: Sinclair BASIC tokenized file format documentation
 */

// Token table for ZX Spectrum 48K/128K BASIC
// Based on official ZX Spectrum character set documentation
const TOKENS: Record<number, string> = {
  // 128K-only tokens
  0xA3: ' SPECTRUM',
  0xA4: ' PLAY ',

  // Standard tokens (0xA5-0xFF)
  0xA5: 'RND',
  0xA6: 'INKEY$',
  0xA7: 'PI',
  0xA8: 'FN ',
  0xA9: 'POINT ',
  0xAA: 'SCREEN$ ',
  0xAB: 'ATTR ',
  0xAC: 'AT ',
  0xAD: 'TAB ',
  0xAE: 'VAL$ ',
  0xAF: 'CODE ',
  0xB0: 'VAL ',
  0xB1: 'LEN',
  0xB2: 'SIN ',
  0xB3: 'COS ',
  0xB4: 'TAN ',
  0xB5: 'ASN ',
  0xB6: 'ACS ',
  0xB7: 'ATN ',
  0xB8: 'LN',
  0xB9: 'EXP ',
  0xBA: 'INT ',
  0xBB: 'SQR ',
  0xBC: 'SGN ',
  0xBD: 'ABS ',
  0xBE: 'PEEK ',
  0xBF: 'IN ',
  0xC0: 'USR ',
  0xC1: 'STR$ ',
  0xC2: 'CHR$ ',
  0xC3: 'NOT ',
  0xC4: 'BIN ',
  0xC5: ' OR ',
  0xC6: ' AND ',
  0xC7: '<=',
  0xC8: '>=',
  0xC9: '<>',
  0xCA: ' LINE ',
  0xCB: ' THEN ',
  0xCC: ' TO ',
  0xCD: ' STEP ',
  0xCE: ' DEF FN ',
  0xCF: ' CAT ',
  0xD0: ' FORMAT ',
  0xD1: ' MOVE ',
  0xD2: ' ERASE ',
  0xD3: ' OPEN #',
  0xD4: ' CLOSE #',
  0xD5: ' MERGE ',
  0xD6: ' VERIFY ',
  0xD7: ' BEEP ',
  0xD8: ' CIRCLE ',
  0xD9: ' INK ',
  0xDA: ' PAPER ',
  0xDB: ' FLASH ',
  0xDC: ' BRIGHT ',
  0xDD: ' INVERSE ',
  0xDE: ' OVER ',
  0xDF: ' OUT ',
  0xE0: ' LPRINT ',
  0xE1: ' LLIST ',
  0xE2: ' STOP ',
  0xE3: ' READ ',
  0xE4: ' DATA ',
  0xE5: ' RESTORE ',
  0xE6: ' NEW ',
  0xE7: ' BORDER ',
  0xE8: ' CONTINUE ',
  0xE9: ' DIM ',
  0xEA: ' REM ',
  0xEB: ' FOR ',
  0xEC: ' GO TO ',
  0xED: ' GO SUB ',
  0xEE: ' INPUT ',
  0xEF: ' LOAD ',
  0xF0: ' LIST ',
  0xF1: ' LET ',
  0xF2: ' PAUSE ',
  0xF3: ' NEXT ',
  0xF4: ' POKE ',
  0xF5: ' PRINT ',
  0xF6: ' PLOT ',
  0xF7: ' RUN ',
  0xF8: ' SAVE ',
  0xF9: ' RANDOMIZE ',
  0xFA: ' IF ',
  0xFB: ' CLS ',
  0xFC: ' DRAW ',
  0xFD: ' CLEAR ',
  0xFE: ' RETURN ',
  0xFF: ' COPY ',
};

/**
 * Detokenize a single BASIC line.
 * Returns the line as a string.
 *
 * Number format: ASCII digits + 0x0E marker + 5 bytes binary form.
 * Only 0x0E is a marker (covers both integer and FP — the body distinguishes).
 * 0x7E is the printable tilde character '~' and must NOT be treated as a marker.
 */
function detokenizeLine(mem: Uint8Array, offset: number, lineEnd: number): string {
  let result = '';
  let i = offset;

  while (i < lineEnd) {
    const byte = mem[i];

    if (byte === 0x0D) {
      // Line terminator (NEWLINE)
      break;
    } else if (byte === 0x0E) {
      // Number marker — skip the marker + the following 5 bytes of binary form.
      i++;
      if (i + 5 <= lineEnd) {
        i += 5;
      }
    } else if (byte >= 0xA3 && byte <= 0xFF) {
      // BASIC token. The strings in TOKENS already carry the surrounding
      // spaces they need (e.g. ' PRINT ', 'LET '), so don't tack on another.
      result += TOKENS[byte];
      i++;
    } else if (byte >= 0x20 && byte < 0x7F) {
      // Printable ASCII (including digits, letters, punctuation)
      result += String.fromCharCode(byte);
      i++;
    } else if (byte === 0x0A) {
      // Embedded newline (in REM or string)
      result += '↵';
      i++;
    } else {
      // Other control character - show as hex for debugging
      result += `[${byte.toString(16).toUpperCase().padStart(2, '0')}]`;
      i++;
    }
  }

  return result;
}

/**
 * Parse a BASIC program from memory.
 * Returns HTML for display.
 */
export function parseBasicProgram(mem: Uint8Array): string {
  // Read PROG and VARS system variables
  const progAddr = mem[0x5C53] | (mem[0x5C54] << 8);
  const varsAddr = mem[0x5C4B] | (mem[0x5C4C] << 8);

  if (progAddr === 0 || varsAddr === 0 || progAddr >= varsAddr) {
    return '<span style="color:#666">(no BASIC program)</span>';
  }

  const lines: string[] = [];
  let offset = progAddr;
  let lineCount = 0;
  const maxLines = 10000; // Safety limit

  while (offset < varsAddr && lineCount < maxLines) {
    // Check for end marker
    if (offset + 4 > varsAddr) break;

    // Read line number (2 bytes, big-endian)
    const lineNumHigh = mem[offset];
    const lineNumLow = mem[offset + 1];

    // 0x80 in high byte marks end of program
    if (lineNumHigh >= 0x80) break;

    const lineNum = (lineNumHigh << 8) | lineNumLow;

    // Read line length (2 bytes, little-endian)
    const lineLen = mem[offset + 2] | (mem[offset + 3] << 8);

    if (lineLen === 0 || offset + 4 + lineLen > varsAddr) break;

    // Detokenize the line
    const lineText = detokenizeLine(mem, offset + 4, offset + 4 + lineLen);

    // Format as HTML with line number
    const lineNumStr = lineNum.toString().padStart(4, ' ');
    lines.push(`<span class="basic-line-num">${lineNumStr}</span> ${escapeHtml(lineText)}`);

    offset += 4 + lineLen;
    lineCount++;
  }

  if (lines.length === 0) {
    return '<span style="color:#666">(empty program)</span>';
  }

  return lines.join('\n');
}

/**
 * Read the dimension sizes recorded in an array variable's data area.
 * Layout from `dataStart`: 1 byte dimCount, then `dimCount` × 16-bit (LE)
 * dimension sizes. Returns [] for arrays with no header (e.g. malformed or
 * test fixtures where dataLen is 0).
 */
function readArrayDims(mem: Uint8Array, dataStart: number, dataLen: number, end: number): number[] {
  if (dataLen < 1 || dataStart >= end) return [];
  const dimCount = mem[dataStart];
  if (dataLen < 1 + 2 * dimCount) return [];
  const dims: number[] = [];
  for (let d = 0; d < dimCount; d++) {
    const lo = dataStart + 1 + d * 2;
    if (lo + 1 >= end) break;
    dims.push(mem[lo] | (mem[lo + 1] << 8));
  }
  return dims;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Parse ZX Spectrum 5-byte number to a displayable value.
 *
 * Two on-disk forms (both 5 bytes):
 *   Integer: [exp=0, sign(0|0xFF), lo, hi, 0] — signed 16-bit value.
 *   Float:   [exp(biased+0x80), m1, m2, m3, m4] — 32-bit mantissa with the
 *            top bit replaced by the sign bit; the implicit leading 1
 *            is restored before computation.
 */
function parse5ByteNumber(mem: Uint8Array, offset: number): string {
  const exp = mem[offset];
  const b1 = mem[offset + 1];
  const b2 = mem[offset + 2];
  const b3 = mem[offset + 3];
  const b4 = mem[offset + 4];

  // Integer format: exp must be 0, b4 must be 0, b1 must be 0 or 0xFF.
  // A non-canonical b1 means we're looking at a corrupted record or an FP
  // value that happened to clear b4 — don't silently re-interpret it as an int.
  if (exp === 0 && b4 === 0 && (b1 === 0x00 || b1 === 0xFF)) {
    const isNeg = b1 === 0xFF;
    let value = b2 | (b3 << 8);
    if (isNeg) value = value - 65536;
    return value.toString();
  }

  // Floating-point. Reconstruct the implicit-1 mantissa, apply the stored
  // sign, then scale by 2^(exp - 0x80 - 32).
  const sign = (b1 & 0x80) ? -1 : 1;
  const mantissa = (b1 | 0x80) * 0x1000000 + b2 * 0x10000 + b3 * 0x100 + b4;
  const value = sign * mantissa * Math.pow(2, exp - 128 - 32);
  return value.toString();
}

/**
 * Parse BASIC variables area from memory.
 * Returns HTML for display.
 */
export function parseBasicVariables(mem: Uint8Array): string {
  // Read VARS and E_LINE system variables
  const varsAddr = mem[0x5C4B] | (mem[0x5C4C] << 8);
  const eLineAddr = mem[0x5C59] | (mem[0x5C5A] << 8);

  if (varsAddr === 0 || eLineAddr === 0 || varsAddr >= eLineAddr) {
    return '<span style="color:#666">(no variables)</span>';
  }

  const lines: string[] = [];
  let offset = varsAddr;
  let varCount = 0;
  const maxVars = 1000; // Safety limit

  while (offset < eLineAddr && varCount < maxVars) {
    const firstByte = mem[offset];
    if (firstByte === 0x80) break; // End marker

    const typeFlags = firstByte & 0xE0;

    // Simple numeric variable (0x60-0x7A)
    if (typeFlags === 0x60) {
      const name = String.fromCharCode(firstByte);
      const value = parse5ByteNumber(mem, offset + 1);
      lines.push(`<span class="var-name">${name}</span> = ${escapeHtml(value)}`);
      offset += 6;
      varCount++;
    }
    // String variable (0x40-0x5A)
    else if (typeFlags === 0x40) {
      const name = String.fromCharCode(firstByte) + '$';
      const len = mem[offset + 1] | (mem[offset + 2] << 8);
      const strData = mem.slice(offset + 3, offset + 3 + len);
      const str = String.fromCharCode(...strData);
      lines.push(`<span class="var-name">${name}</span> = "${escapeHtml(str)}"`);
      offset += 3 + len;
      varCount++;
    }
    // Numeric array (0x80-0x9A)
    else if (typeFlags === 0x80) {
      const baseName = String.fromCharCode(firstByte - 0x20);
      const dataLen = mem[offset + 1] | (mem[offset + 2] << 8);
      const dims = readArrayDims(mem, offset + 3, dataLen, eLineAddr);
      const display = dims.length > 0
        ? `${baseName}(${dims.join(',')})`
        : `${baseName}()`;
      lines.push(`<span class="var-name">${display}</span> <span style="color:#888">[array]</span>`);
      offset += 3 + dataLen;
      varCount++;
    }
    // String array (0xC0-0xDA)
    else if (typeFlags === 0xC0) {
      const baseName = String.fromCharCode(firstByte - 0x80);
      const dataLen = mem[offset + 1] | (mem[offset + 2] << 8);
      const dims = readArrayDims(mem, offset + 3, dataLen, eLineAddr);
      const display = dims.length > 0
        ? `${baseName}$(${dims.join(',')})`
        : `${baseName}$()`;
      lines.push(`<span class="var-name">${display}</span> <span style="color:#888">[array]</span>`);
      offset += 3 + dataLen;
      varCount++;
    }
    // Multi-char numeric variable (0xA0-0xBA)
    else if (typeFlags === 0xA0) {
      let name = String.fromCharCode((firstByte & 0x1F) + 0x60);
      let i = offset + 1;
      while (i < eLineAddr) {
        const ch = mem[i];
        if (ch & 0x80) {
          name += String.fromCharCode(ch & 0x7F);
          i++;
          break;
        }
        name += String.fromCharCode(ch);
        i++;
      }
      const value = parse5ByteNumber(mem, i);
      lines.push(`<span class="var-name">${name}</span> = ${escapeHtml(value)}`);
      offset = i + 5;
      varCount++;
    }
    // FOR-NEXT control variable (0xE0-0xFA)
    else if (typeFlags === 0xE0) {
      const name = String.fromCharCode(firstByte - 0x80);
      const current = parse5ByteNumber(mem, offset + 1);
      const limit = parse5ByteNumber(mem, offset + 6);
      const step = parse5ByteNumber(mem, offset + 11);
      lines.push(`<span class="var-name">${name}</span> = ${escapeHtml(current)} <span style="color:#888">TO ${escapeHtml(limit)} STEP ${escapeHtml(step)}</span>`);
      offset += 19;
      varCount++;
    }
    else {
      // Unknown variable type - skip it
      break;
    }
  }

  if (lines.length === 0) {
    return '<span style="color:#666">(no variables defined)</span>';
  }

  return lines.join('\n');
}
