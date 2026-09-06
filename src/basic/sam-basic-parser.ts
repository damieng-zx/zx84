/**
 * SAM BASIC program and variable-area parser.
 *
 * SAM BASIC is Sinclair-shaped at a distance and different in every detail
 * that matters, so nothing here is shared with the Spectrum parser:
 *
 *  - **The program does not live in the 64K address space.** BASIC's pointers
 *    are page + offset (see `machines/sam/sysvars.ts`), and a program runs on
 *    past the end of a page into the next one. So this reads PAGES, through a
 *    `SamPageReader`, and never the CPU's current view — which a running
 *    program is free to re-page underneath a debug pane.
 *  - **Its token table is its own.** `PRINT` is 0xBB, not the Spectrum's 0xF5.
 *  - **Variables are indexed by first letter.** The numeric area opens with 26
 *    two-byte offsets, one per initial letter, each heading a chain. A
 *    variable's name therefore omits its own first letter — it is implied by
 *    which chain the entry is in.
 *
 * Line format (Technical Manual, "Format Of A Basic Program"):
 *
 *     LINE NUMBER (MSB/LSB) : LINE LENGTH (LSB/MSB) : TEXT : 0DH
 *
 * The line number is big-endian, which is the opposite way round to the
 * length. `FFH` where a line number would start ends the program, so the
 * highest usable line number is 0xFEFF.
 *
 * Every parser here is defensive: the pointers come from live RAM that may be
 * mid-edit, uninitialised, or simply not BASIC's at all, so each walk has a
 * hard iteration cap and every read is bounds-checked rather than trusted.
 */

import type { BasicListingLine, BasicVariable } from './types.ts';
import {
  SAM_EOL, SAM_FN_PREFIX, SAM_FUNCTIONS, SAM_NUMBER_MARKER, SAM_TOKENS,
} from './sam-basic-tokens.ts';

/** Reads one byte of a physical 16K RAM page. Out-of-range pages read 0xFF. */
export type SamPageReader = (page: number, offset: number) => number;

const PAGE_SIZE = 0x4000;

/** Most lines to walk before deciding the pointer was not a program. */
const MAX_LINES = 4000;
/** Most variables to walk before deciding the chain is corrupt. */
const MAX_VARS = 512;
/** Longest name a numeric variable can have (5-bit length field, +1). */
const MAX_NAME = 32;
/** The numeric area opens with one 2-byte chain head per initial letter. */
const LETTER_TABLE_BYTES = 26 * 2;

/** A page/offset cursor that carries into the next page as it advances. */
interface Cursor { page: number; offset: number; }

function step(c: Cursor, n = 1): void {
  c.offset += n;
  while (c.offset >= PAGE_SIZE) { c.offset -= PAGE_SIZE; c.page++; }
}

function at(read: SamPageReader, c: Cursor, n: number): number {
  const page = c.page + Math.floor((c.offset + n) / PAGE_SIZE);
  return read(page, (c.offset + n) % PAGE_SIZE);
}

/** A resolved page/offset pointer into BASIC's memory. */
export interface SamBasicPointer {
  readonly page: number;
  readonly offset: number;
}

/**
 * Where BASIC's memory areas start, as this parser needs them.
 *
 * Each is null until the ROM has written it — which is not a rare edge case
 * but the first few seconds of every cold boot, while the RAM test runs.
 */
export interface SamBasicAnchors {
  /** Program start (PROG). */
  readonly prog: SamBasicPointer | null;
  /** Numeric and FOR-NEXT variables start (NVARS). */
  readonly nvars: SamBasicPointer | null;
  /** String and array variables start (SAVARS). */
  readonly savars: SamBasicPointer | null;
}

// ── Program listing ─────────────────────────────────────────────────────────

/**
 * Detokenise one line's bytes.
 *
 * Two rules do all the work, and both are about spacing. SAM BASIC stores
 * keywords as bare bytes with no surrounding spaces — `LET a=42` is stored as
 * `9C 61 3D 34 32 …` — so a lister has to put the spaces back, and put them
 * back only where a word needs separating from what is next to it. Keywords
 * made of punctuation (`<=`, `<>`) need none at all.
 *
 * Inside quotes nothing is a keyword: codes 0x85 and up are user-defined
 * graphics there, which is why quote state is tracked.
 */
function detokenise(bytes: number[]): string {
  let out = '';
  let inQuotes = false;

  const needsGap = (s: string) => /[A-Za-z0-9$]/.test(s);
  const emitWord = (word: string) => {
    if (out.length > 0 && needsGap(word[0]) && needsGap(out[out.length - 1])) out += ' ';
    out += word;
  };

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];

    if (b === SAM_NUMBER_MARKER) {
      // The invisible form of a literal the digits before it already spell
      // out. Five bytes of floating point, skipped whole.
      i += 5;
      continue;
    }

    if (b === 0x22) { inQuotes = !inQuotes; out += '"'; continue; }

    if (!inQuotes && b === SAM_FN_PREFIX) {
      const word = SAM_FUNCTIONS[bytes[i + 1]];
      i++;
      if (word === undefined) { out += `{FF ${hex2(bytes[i])}}`; continue; }
      emitWord(word);
      // A function is always followed by its argument, so separate them.
      if (needsGap(word[word.length - 1])) {
        const next = bytes[i + 1];
        if (next !== undefined && next !== 0x20 && isNameish(next)) out += ' ';
      }
      continue;
    }

    if (!inQuotes && b >= 0x85 && b <= 0xFE) {
      const word = SAM_TOKENS[b];
      if (word === undefined) { out += `{${hex2(b)}}`; continue; }
      emitWord(word);
      const next = bytes[i + 1];
      if (needsGap(word[word.length - 1]) && next !== undefined
        && next !== 0x20 && isNameish(next)) out += ' ';
      continue;
    }

    if (b >= 0x20 && b <= 0x7E) { out += String.fromCharCode(b); continue; }

    // Anything else is a control code (colour, AT, cursor movement) or a
    // graphic. Shown as its hex value rather than dropped, so a line that
    // carries one does not read as if it did not.
    out += `{${hex2(b)}}`;
  }

  return out;
}

function isNameish(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5A)
    || (code >= 0x61 && code <= 0x7A) || code === 0x22 || code === 0x24;
}

function hex2(b: number): string {
  return (b ?? 0).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Walk the tokenised program from PROG and return its lines.
 *
 * A line whose declared length would run off the end of fitted RAM, or whose
 * terminator is missing, ends the walk: that is a pointer into something that
 * is not a program, and guessing further only produces noise.
 */
export function parseSamProgram(
  read: SamPageReader,
  prog: { page: number; offset: number },
): BasicListingLine[] {
  const lines: BasicListingLine[] = [];
  const c: Cursor = { page: prog.page, offset: prog.offset };

  for (let n = 0; n < MAX_LINES; n++) {
    const hi = at(read, c, 0);
    if (hi === 0xFF) break;                      // end-of-program marker
    const lineNumber = (hi << 8) | at(read, c, 1);
    if (lineNumber === 0) break;                 // line 0 does not exist
    const length = at(read, c, 2) | (at(read, c, 3) << 8);
    // The length covers the text plus its 0x0D, so 1 is the shortest legal
    // line and anything past 16K is a pointer that has gone wrong.
    if (length < 1 || length > PAGE_SIZE) break;

    const bytes: number[] = [];
    for (let i = 0; i < length - 1; i++) bytes.push(at(read, c, 4 + i));
    if (at(read, c, 4 + length - 1) !== SAM_EOL) break;

    lines.push({ lineNumber, text: detokenise(bytes) });
    step(c, 4 + length);
  }

  return lines;
}

// ── Numeric and FOR-NEXT variables ──────────────────────────────────────────

/**
 * Decode SAM BASIC's five-byte floating point.
 *
 * The layout is the Spectrum's, because the calculator is: a zero exponent
 * means the "small integer" form (sign byte then a 16-bit value), and anything
 * else is a binary exponent biased by 128 with an implied leading 1 in the
 * mantissa's top bit.
 */
function readFloat(read: SamPageReader, c: Cursor, from: number): number {
  const b = [0, 1, 2, 3, 4].map(i => at(read, c, from + i));
  if (b[0] === 0) {
    const value = b[2] | (b[3] << 8);
    return b[1] === 0 ? value : value - 65536;
  }
  const exp = b[0] - 128;
  const mantissa = ((b[1] | 0x80) * 0x1000000 + b[2] * 0x10000 + b[3] * 0x100 + b[4]) / 0x100000000;
  const value = mantissa * Math.pow(2, exp);
  return (b[1] & 0x80) ? -value : value;
}

/** Trim a float to something readable without inventing precision. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(9)));
}

/**
 * Walk the numeric-variable area.
 *
 * The area opens with 26 two-byte offsets, one per initial letter; 0xFFFF
 * means no variable starts with that letter. Each entry, and each variable's
 * own 2-byte offset field, is measured **from the high byte of that offset** —
 * so the next entry is at (address of the MSB) + offset. Measuring from the
 * start of the record instead puts every chain one byte out, which reads as a
 * plausible-looking variable with a shifted name.
 */
export function parseSamNumericVars(
  read: SamPageReader,
  nvars: { page: number; offset: number },
): BasicVariable[] {
  const out: BasicVariable[] = [];
  const base: Cursor = { page: nvars.page, offset: nvars.offset };

  for (let letter = 0; letter < 26; letter++) {
    const entry = letter * 2;
    let offset = at(read, base, entry) | (at(read, base, entry + 1) << 8);
    if (offset === 0xFFFF) continue;

    // Distance is measured from the offset's own high byte.
    let from = entry + 1 + offset;
    // Every variable lives past the 52-byte letter table, so a head pointing
    // back into the table is not a chain — it is uninitialised memory, where
    // an all-zero table otherwise reads as twenty-six variables per letter.
    if (from < LETTER_TABLE_BYTES) continue;
    for (let n = 0; n < MAX_VARS; n++) {
      const type = at(read, base, from);
      if (type === 0xFF) break;
      const nameLen = (type & 0x1F) + 1;
      if (nameLen > MAX_NAME) break;

      const hidden = (type & 0x80) !== 0;
      const dead = (type & 0x20) !== 0;
      const forNext = (type & 0x40) !== 0;

      let name = String.fromCharCode(0x61 + letter);
      for (let i = 1; i < nameLen; i++) name += String.fromCharCode(at(read, base, from + 3 + i - 1));

      const valueAt = from + 3 + (nameLen - 1);
      if (!hidden && !dead) {
        const value = formatNumber(readFloat(read, base, valueAt));
        if (forNext) {
          const limit = formatNumber(readFloat(read, base, valueAt + 5));
          const stepBy = formatNumber(readFloat(read, base, valueAt + 10));
          out.push({ name, kind: 'for-next', value, detail: `TO ${limit} STEP ${stepBy}` });
        } else {
          out.push({ name, kind: 'number', value });
        }
      }

      offset = at(read, base, from + 1) | (at(read, base, from + 2) << 8);
      if (offset === 0xFFFF) break;
      const next = from + 2 + offset;
      if (next <= from) break;   // a chain that does not move forward is corrupt
      from = next;
    }
  }

  return out;
}

// ── Strings and arrays ──────────────────────────────────────────────────────

/**
 * Walk the string and array area.
 *
 * Entries are in creation order, each a fixed 14-byte header —
 * `type/length, 10 name bytes, 3 length bytes` — followed by the data. The
 * length is a page count and then a length MOD 16K; 0xFF where a type byte
 * would be ends the list.
 *
 * The manual describes that length as covering "the rest of the array plus the
 * 3 length bytes". It does not: a 5-character string measures 5, with its data
 * starting immediately after the 14-byte header. Measured on a real `LET
 * z$="hello"`, because reading it the manual's way puts every entry after the
 * first three bytes out of step.
 */
export function parseSamStringVars(
  read: SamPageReader,
  savars: { page: number; offset: number },
): BasicVariable[] {
  const out: BasicVariable[] = [];
  const c: Cursor = { page: savars.page, offset: savars.offset };

  for (let n = 0; n < MAX_VARS; n++) {
    const type = at(read, c, 0);
    if (type === 0xFF || type === 0) break;

    const nameLen = type & 0x1F;
    if (nameLen < 1 || nameLen > 10) break;
    const stringArray = (type & 0x40) !== 0;
    const numericArray = (type & 0x20) !== 0;
    const hidden = (type & 0x80) !== 0;

    let name = '';
    for (let i = 0; i < nameLen; i++) name += String.fromCharCode(at(read, c, 1 + i));

    const pages = at(read, c, 11);
    const payload = pages * PAGE_SIZE + (at(read, c, 12) | (at(read, c, 13) << 8));
    if (payload < 0) break;

    if (!hidden) {
      if (numericArray || stringArray) {
        // The data opens with a dimension count and then one 16-bit bound per
        // dimension, which is what makes `q(3)` readable as `q(3)` rather than
        // as a bare name.
        const dims = at(read, c, 14);
        const bounds: number[] = [];
        for (let d = 0; d < dims && d < 8; d++) {
          bounds.push(at(read, c, 15 + d * 2) | (at(read, c, 16 + d * 2) << 8));
        }
        const sub = bounds.length > 0 ? `(${bounds.join(',')})` : '()';
        out.push({ name: `${name}${stringArray ? '$' : ''}${sub}`, kind: 'array' });
      } else {
        let text = '';
        const shown = Math.min(payload, 128);
        for (let i = 0; i < shown; i++) {
          const ch = at(read, c, 14 + i);
          text += ch >= 0x20 && ch <= 0x7E ? String.fromCharCode(ch) : '.';
        }
        if (payload > shown) text += '…';
        out.push({ name: `${name}$`, kind: 'string', value: text });
      }
    }

    step(c, 14 + payload);
  }

  return out;
}

// ── Entry points used by the frame probe ────────────────────────────────────

/**
 * Resolve BASIC's anchors from the system-variable page and list the program.
 *
 * `read` must be a physical page reader; the anchors are resolved from page 0
 * because that is where the ROM keeps them regardless of how the machine is
 * currently paged.
 */
export function parseSamBasic(read: SamPageReader): BasicListingLine[] {
  const { prog } = samBasicAnchors(read);
  return prog ? parseSamProgram(read, prog) : [];
}

/** Numeric, FOR-NEXT, string and array variables, in that order. */
export function parseSamBasicVariables(read: SamPageReader): BasicVariable[] {
  const { nvars, savars } = samBasicAnchors(read);
  return [
    ...(nvars ? parseSamNumericVars(read, nvars) : []),
    ...(savars ? parseSamStringVars(read, savars) : []),
  ];
}

/**
 * Read PROG / NVARS / SAVARS out of the system-variable page.
 *
 * Kept here rather than imported from the machine folder so the parser stays a
 * plain function of memory — the debug layer must not reach into a machine.
 * The addresses are the manual's, relative to the 0x4000 window page 0 sits
 * in; the stored offsets are 0x8000-based and fold into the page number.
 */
export function samBasicAnchors(read: SamPageReader): SamBasicAnchors {
  return {
    prog: pointer(read, 0x5A9F),
    nvars: pointer(read, 0x5A87),
    savars: pointer(read, 0x5A81),
  };
}

const SYSVAR_PAGE = 0;
const SYSVAR_WINDOW = 0x4000;

function pointer(read: SamPageReader, addr: number): SamBasicPointer | null {
  const at0 = addr - SYSVAR_WINDOW;
  const page = read(SYSVAR_PAGE, at0);
  const raw = (read(SYSVAR_PAGE, at0 + 2) << 8) | read(SYSVAR_PAGE, at0 + 1);
  // A stored offset is 0x8000-based and "always less than 32K" (Technical
  // Manual), so anything below 0x8000 is not a pointer yet. That is the state
  // the whole system-variable page is in for the first few seconds after
  // reset, while the ROM runs its RAM test: every byte reads zero, and taking
  // it at face value aims the walkers at page 0 offset 0 and marches them
  // through zeroed RAM inventing a variable every other byte.
  if (raw < 0x8000) return null;
  let offset = raw - 0x8000;
  let carry = 0;
  while (offset >= PAGE_SIZE) { offset -= PAGE_SIZE; carry++; }
  return { page: page + carry, offset };
}
