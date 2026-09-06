/**
 * SAM BASIC keyword codes.
 *
 * Transcribed verbatim from the SAM Coupé Technical Manual v3.0, "Keyword
 * Codes". SAM BASIC's tokens are NOT the Spectrum's: `PRINT` is 0xBB here and
 * 0xF5 there, and the two sets overlap enough that using the wrong table
 * produces a listing that looks almost plausible.
 *
 * The encoding has three ranges:
 *
 *  - **Functions are two bytes**: 0xFF then 0x3B-0x84. 0xFF has no other use.
 *  - **0x85-0x8F are qualifiers** — `THEN`, `TO`, `STEP` and friends. They
 *    modify a command rather than doing anything themselves.
 *  - **0x90-0xFE are commands.**
 *
 * Codes the manual marks "Reserved" are left out of the tables entirely, so an
 * unknown byte is rendered as an escape rather than as a keyword that does not
 * exist.
 *
 * A subtlety the manual is explicit about: codes 0x85-0xFE are also UDG
 * characters. They list as keywords outside quotes and print as user-defined
 * graphics inside them — which is why the detokeniser tracks quote state.
 */

/** Prefix byte introducing a two-byte function token. */
export const SAM_FN_PREFIX = 0xFF;

/** Invisible numeric literal: this byte then five bytes of floating point. */
export const SAM_NUMBER_MARKER = 0x0E;

/** End-of-line marker inside a program line. */
export const SAM_EOL = 0x0D;

/** Functions, indexed by the byte following 0xFF (0x3B-0x84). */
export const SAM_FUNCTIONS: Readonly<Record<number, string>> = {
  0x3B: 'PI', 0x3C: 'RND', 0x3D: 'POINT', 0x3E: 'FREE', 0x3F: 'LENGTH',
  0x40: 'ITEM', 0x41: 'ATTR', 0x42: 'FN', 0x43: 'BIN', 0x44: 'XMOUSE',
  0x45: 'YMOUSE', 0x46: 'XPEN', 0x47: 'YPEN', 0x48: 'RAMTOP',
  0x4A: 'INSTR', 0x4B: 'INKEY$', 0x4C: 'SCREEN$', 0x4D: 'MEM$',
  0x4F: 'PATH$', 0x50: 'STRING$',
  0x53: 'SIN', 0x54: 'COS', 0x55: 'TAN', 0x56: 'ASN', 0x57: 'ACS',
  0x58: 'ATN', 0x59: 'LN', 0x5A: 'EXP', 0x5B: 'ABS', 0x5C: 'SGN',
  0x5D: 'SQR', 0x5E: 'INT', 0x5F: 'USR', 0x60: 'IN', 0x61: 'PEEK',
  0x62: 'DPEEK', 0x63: 'DVAR', 0x64: 'SVAR', 0x65: 'BUTTON', 0x66: 'EOF',
  0x67: 'PTR', 0x69: 'UDG', 0x6B: 'LEN', 0x6C: 'CODE', 0x6D: 'VAL$',
  0x6E: 'VAL', 0x6F: 'TRUNC$', 0x70: 'CHR$', 0x71: 'STR$', 0x72: 'BIN$',
  0x73: 'HEX$', 0x74: 'USR$', 0x76: 'NOT',
  0x7A: 'MOD', 0x7B: 'DIV', 0x7C: 'BOR', 0x7E: 'BAND', 0x7F: 'OR',
  0x80: 'AND', 0x81: '<>', 0x82: '<=', 0x83: '>=',
};

/**
 * Single-byte tokens: qualifiers (0x85-0x8F) then commands (0x90-0xFE).
 *
 * The four `IF`/`ELSE` entries collapse the manual's long/short pair to the
 * one word a listing shows — the distinction is how the ROM parses the rest of
 * the statement, not what it prints.
 */
export const SAM_TOKENS: Readonly<Record<number, string>> = {
  // Qualifiers
  0x85: 'USING', 0x86: 'WRITE', 0x87: 'AT', 0x88: 'TAB', 0x89: 'OFF',
  0x8A: 'WHILE', 0x8B: 'UNTIL', 0x8C: 'LINE', 0x8D: 'THEN', 0x8E: 'TO',
  0x8F: 'STEP',
  // Commands
  0x90: 'DIR', 0x91: 'FORMAT', 0x92: 'ERASE', 0x93: 'MOVE', 0x94: 'SAVE',
  0x95: 'LOAD', 0x96: 'MERGE', 0x97: 'VERIFY', 0x98: 'OPEN', 0x99: 'CLOSE',
  0x9A: 'CIRCLE', 0x9B: 'PLOT', 0x9C: 'LET', 0x9D: 'BLITZ', 0x9E: 'BORDER',
  0x9F: 'CLS', 0xA0: 'PALETTE', 0xA1: 'PEN', 0xA2: 'PAPER', 0xA3: 'FLASH',
  0xA4: 'BRIGHT', 0xA5: 'INVERSE', 0xA6: 'OVER', 0xA7: 'FATPIX',
  0xA8: 'CSIZE', 0xA9: 'BLOCKS', 0xAA: 'MODE', 0xAB: 'GRAB', 0xAC: 'PUT',
  0xAD: 'BEEP', 0xAE: 'SOUND', 0xAF: 'NEW', 0xB0: 'RUN', 0xB1: 'STOP',
  0xB2: 'CONTINUE', 0xB3: 'CLEAR', 0xB4: 'GO TO', 0xB5: 'GO SUB',
  0xB6: 'RETURN', 0xB7: 'REM', 0xB8: 'READ', 0xB9: 'DATA', 0xBA: 'RESTORE',
  0xBB: 'PRINT', 0xBC: 'LPRINT', 0xBD: 'LIST', 0xBE: 'LLIST', 0xBF: 'DUMP',
  0xC0: 'FOR', 0xC1: 'NEXT', 0xC2: 'PAUSE', 0xC3: 'DRAW', 0xC4: 'DEFAULT',
  0xC5: 'DIM', 0xC6: 'INPUT', 0xC7: 'RANDOMIZE', 0xC8: 'DEF FN',
  0xC9: 'DEF KEYCODE', 0xCA: 'DEF PROC', 0xCB: 'END PROC', 0xCC: 'RENUM',
  0xCD: 'DELETE', 0xCE: 'REF', 0xCF: 'COPY', 0xD1: 'KEYIN', 0xD2: 'LOCAL',
  0xD3: 'LOOP IF', 0xD4: 'DO', 0xD5: 'LOOP', 0xD6: 'EXIT IF', 0xD7: 'IF',
  0xD8: 'IF', 0xD9: 'ELSE', 0xDA: 'ELSE', 0xDB: 'END IF', 0xDC: 'KEY',
  0xDD: 'ON ERROR', 0xDE: 'ON', 0xDF: 'GET', 0xE0: 'OUT', 0xE1: 'POKE',
  0xE2: 'DPOKE', 0xE3: 'RENAME', 0xE4: 'CALL', 0xE5: 'ROLL', 0xE6: 'SCROLL',
  0xE7: 'SCREEN', 0xE8: 'DISPLAY', 0xE9: 'BOOT', 0xEA: 'LABEL',
  0xEB: 'FILL', 0xEC: 'WINDOW', 0xED: 'AUTO', 0xEE: 'POP', 0xEF: 'RECORD',
  0xF0: 'DEVICE', 0xF1: 'PROTECT', 0xF2: 'HIDE', 0xF3: 'ZAP', 0xF4: 'POW',
  0xF5: 'BOOM', 0xF6: 'ZOOM',
};
