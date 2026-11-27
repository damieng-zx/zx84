/**
 * Oric BASIC 1.x listing and variable reader.
 *
 * Programs are tokenised into **records** in the BASIC text area, which starts
 * at `$0501` — one byte past the spare page at `$0400`, which the disk system
 * uses. Each record is:
 *
 *   link-lo  link-hi  line-lo  line-hi  <body…>  0x00
 *
 * `link` is the absolute address of the *next* record (which is how BASIC jumps
 * straight to a line number), the line number is a 16-bit big... little-endian
 * pair, and the body is the tokenised line: keyword token codes, plain ASCII for
 * everything else, and a `REM` that takes the rest of the record literally.
 * There is no length byte — the body runs to its `0x00`.
 *
 * The program ends at the first record whose link has a zero high byte (a link
 * below `$0100`), which is what an empty program is: one such record.
 *
 * **Pointers (page 2, per the Oric reference):**
 *
 *   `$9A`/`$9B`  start of the BASIC text (`$0500`; the first record is at +1)
 *   `$9C`/`$9D`  start of the simple variables — i.e. the end of the program+1
 *   `$9E`/`$9F`  start of the arrays, i.e. the end of the simple variables
 *   `$A0`/`$A1`  end of the arrays
 *   `$A2`/`$A3`  top of the string space, which grows down from `$A6`
 *
 * The token table is read from the resident ROM rather than hardcoded: BASIC
 * keeps its keywords as `$`-terminated upper-case strings whose last letter has
 * bit 7 set (`EN` + `$C4` = `END`), and a keyword's code is its position in that
 * table, **starting at `$80`**. Reading it from the ROM means a patched or
 * alternate BASIC gets the right keywords; it was also the only way to settle
 * the code range, which the ROM's own `POKE`-is-`$B9` confirms.
 */

import type { BasicListingLine, BasicVariable } from './types.ts';

/** Page-2 pointers, as above. */
const ZP_TEXT_START = 0x9A;
const ZP_VARIABLES = 0x9C;
const ZP_ARRAYS = 0x9E;
const ZP_ARRAY_END = 0xA0;
const ZP_STRING_TOP = 0xA2;

/** The program's first record: the text page's base plus one. */
const PROGRAM_FIRST_RECORD = 0x0501;
/** A keyword's first code. */
const FIRST_TOKEN = 0x80;
/** Where the ROM's keyword table starts (the `E` of `END`). */
const ROM_TOKEN_TABLE_BASE = 0xC0EA;

export interface OricTokenTable {
  /** Indexed by token *code*, so `words[0xB9]` is `POKE`. */
  readonly words: readonly string[];
}

/**
 * Read the keyword and operator table out of the resident ROM.
 *
 * It is **one continuous table of 119 entries**, from `END` (`$80`) through the
 * keywords to the functions (`NEW`, `TAB(`, `TO`, `FN`, `SPC(`, `@` …) and on
 * to the operators and math functions (`=`, `<`, `+`, `-`, `*`, `/`, `^`,
 * `AND`, `OR`, `ABS`, `SQR`, `RND` …). Three independent codes confirm the
 * alignment against the published table: `POKE` is `$B9`, `PRINT` `$BA`, and
 * `FOR` `$8D`.
 *
 * Each entry is upper-case letters, and the **last** letter carries bit 7 as its
 * terminator. An entry may also end in a literal symbol instead — `TAB(` and
 * `SPC(` are spelled with their bracket, and `=` `+` `-` `*` are the symbols
 * themselves — so a byte that is neither is either such a trailing symbol or the
 * end of the table, and the walk continues while it can still make progress.
 */
export function readOricTokenTable(rom: Uint8Array): OricTokenTable {
  const words: string[] = [];
  while (words.length < FIRST_TOKEN) words.push('');
  let current = '';
  let p = ROM_TOKEN_TABLE_BASE - 0xC000;
  while (p < rom.length) {
    const b = rom[p];
    if (b >= 0x41 && b <= 0x5A) { current += String.fromCharCode(b); p++; continue; }
    if (b >= 0x80) {
      current += String.fromCharCode(b & 0x7F);
      words.push(current);
      current = '';
      p++;
      continue;
    }
    // A literal symbol ending an entry: `TAB(`, `SPC(`, `=`, `&` …
    if (current || (b >= 0x20 && b < 0x7F)) {
      words.push(current + String.fromCharCode(b));
      current = '';
      p++;
      continue;
    }
    break;
  }
  return { words };
}

/** A byte as the character it denotes in a listing. */
function plainByte(b: number): string {
  if (b === 0x7F) return '\u00a3';
  if (b >= 0x20 && b < 0x7F) return String.fromCharCode(b);
  return '.';
}

/**
 * Detokenise one record's body. A token becomes its keyword plus a space, unless
 * it is `REM`, which takes the remainder of the record literally.
 */
function detokenise(body: Uint8Array, table: OricTokenTable): string {
  let out = '';
  let inRem = false;
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b === 0) break;
    if (inRem) { out += plainByte(b); continue; }
    const word = b >= FIRST_TOKEN ? table.words[b] : undefined;
    if (word) {
      out += word;
      if (word === 'REM') inRem = true;
      else out += ' ';
      continue;
    }
    out += plainByte(b);
  }
  return out.replace(/\s+$/, '').replace(/ {2,}/g, ' ');
}

function zpWord(ram: Uint8Array, at: number): number {
  return ram[at] | (ram[at + 1] << 8);
}

/** The address of the first program record, or null when there is no program. */
export function oricProgramStart(ram: Uint8Array): number | null {
  // $9A holds the address of the first record itself ($0501), not a page base.
  const start = zpWord(ram, ZP_TEXT_START);
  if (start >= 0x0400 && start < 0xC000) return start;
  // A machine that has never run BASIC leaves the pointer null; the text area
  // still begins where it always does.
  return PROGRAM_FIRST_RECORD;
}

/**
 * Detokenise the resident BASIC program. Returns an empty list when there is
 * none, which is when the very first record's link high byte is zero.
 */
export function parseOricBasic(ram: Uint8Array, table: OricTokenTable): BasicListingLine[] {
  const start = oricProgramStart(ram);
  if (start === null) return [];

  const lines: BasicListingLine[] = [];
  let at = start;
  for (let guard = 0; guard < 0x4000; guard++) {
    if (at < 0x0400 || at >= 0xC000) break;
    const link = zpWord(ram, at);
    // The terminator record's link is below $0100: its high byte is zero.
    if ((link >> 8) === 0) break;

    const lineNumber = zpWord(ram, at + 2);
    // The body runs from +4 to the 0x00 that ends the record.
    const bodyStart = at + 4;
    let bodyEnd = bodyStart;
    while (bodyEnd < 0xC000 && ram[bodyEnd] !== 0x00) bodyEnd++;
    lines.push({
      lineNumber,
      text: detokenise(ram.subarray(bodyStart, bodyEnd), table),
    });

    if (link === at) break;
    at = link;
  }
  return lines;
}

/**
 * Read BASIC's memory map.
 *
 * The exact numeric/string/array slot layouts are documented per revision and
 * differ between BASIC 1.0 and 1.1, so rather than decode them and risk printing
 * a wrong value this reports the allocation map — which is exact, comes straight
 * from the pointers BASIC maintains itself, and is what tells you where a
 * program's variables live.
 */
export function parseOricBasicVariables(ram: Uint8Array): BasicVariable[] {
  const text = zpWord(ram, ZP_TEXT_START);
  const vars = zpWord(ram, ZP_VARIABLES);
  const arrays = zpWord(ram, ZP_ARRAYS);
  const arrayEnd = zpWord(ram, ZP_ARRAY_END);
  const strings = zpWord(ram, ZP_STRING_TOP);
  // A machine that has never run BASIC has null pointers; report nothing.
  if (text < 0x0400 || vars < text || vars > 0xC000) return [];

  return [
    {
      name: 'PROGRAM',
      kind: 'number',
      value: `$${text.toString(16)}`,
      detail: `ends $${vars.toString(16)} — ${vars - text} bytes`,
    },
    {
      name: 'VARIABLES',
      kind: 'number',
      value: `$${vars.toString(16)}`,
      detail: `${arrays - vars} bytes`,
    },
    {
      name: 'ARRAYS',
      kind: 'number',
      value: `$${arrays.toString(16)}`,
      detail: `${arrayEnd - arrays} bytes`,
    },
    {
      name: 'STRINGS',
      kind: 'number',
      value: `$${strings.toString(16)}`,
      detail: strings ? `grows down from $${strings.toString(16)}` : '',
    },
  ];
}
