/**
 * System BASIC (the 4K integer BASIC) program and variable decode.
 *
 * The language keeps its program as plain text, not tokens: a line is
 *
 *     [line number high] [line number low] [source text] &0D
 *
 * and LIST simply prints the bytes until the CR (see the BASIC source's LIST
 * routine). That is why no detokeniser is needed here — only the line framing,
 * which the listing walk implements.
 *
 * The variables are the language's own fixed workspace (BASIC.ca65, "BASIC
 * Workspace"): 26 four-byte integers in four parallel pages from &0322, and a
 * 15-deep FOR stack in &0240/&024F/&028B. Strings and arrays live in the text
 * area with pointers and are not decoded here.
 */

import type { BasicListingLine, BasicVariable } from '@/basic/types.ts';
import type { AcornSystemMemory } from './memory.ts';

/** Bottom-of-text-area page (zero-page `txtpag`). */
const TXTPAG = 0x12;
/** Top of the text area (zero-page `TOP`, two bytes, little-endian). */
const TOP = 0x0D;
/** FOR loop counter (zero-page `forcnt`). */
const FORCNT = 0x15;
/** FOR loop stacks: variable number, STEP (4 bytes/level), TO (4 bytes/level). */
const FORVAR = 0x0240;
const STEPA = 0x024F;
const FORTOA = 0x028B;
const FOR_LEVELS = 15;
/** The four parallel pages holding integer variables A-Z. */
const INTEG = [0x0322, 0x033D, 0x0358, 0x0373] as const;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A signed 32-bit integer at `addr` + `index` across the four pages. */
function readInt(mem: AcornSystemMemory, index: number): number {
  const b0 = mem.peekByte(INTEG[0] + index);
  const b1 = mem.peekByte(INTEG[1] + index);
  const b2 = mem.peekByte(INTEG[2] + index);
  const b3 = mem.peekByte(INTEG[3] + index);
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) | 0;
}

/** A packed four-byte integer from an arbitrary base address. */
function readLong(mem: AcornSystemMemory, base: number, index: number): number {
  const b0 = mem.peekByte(base + index);
  const b1 = mem.peekByte(base + FOR_LEVELS + index);
  const b2 = mem.peekByte(base + FOR_LEVELS * 2 + index);
  const b3 = mem.peekByte(base + FOR_LEVELS * 3 + index);
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) | 0;
}

/**
 * The stored program, or an empty list when BASIC is not fitted or the text
 * area does not hold a well-formed line sequence (garbage RAM, a program being
 * typed). Every walk is bounded by TOP, so a corrupt pointer cannot loop.
 */
export function systemBasicListing(mem: AcornSystemMemory): BasicListingLine[] {
  if (!mem.basicFitted) return [];
  const bottom = mem.peekByte(TXTPAG) << 8;
  const top = mem.peekByte(TOP) | (mem.peekByte(TOP + 1) << 8);
  if (bottom < 0x2000 || bottom >= 0xC000) return [];
  if (top <= bottom || top > 0xC000) return [];
  if (top - bottom > 0x4000) return [];

  const lines: BasicListingLine[] = [];
  let p = bottom;
  while (p < top) {
    // The text area ends with the &FF end-of-program marker, which TOP points past.
    if (mem.peekByte(p) === 0xFF) break;
    if (mem.peekByte(p) === 0x0D) { p++; continue; }
    if (p + 2 > top) return [];
    const number = (mem.peekByte(p) << 8) | mem.peekByte(p + 1);
    if (number < 1 || number > 9999) return [];
    p += 2;
    let text = '';
    while (p < top && mem.peekByte(p) !== 0x0D) {
      const b = mem.peekByte(p);
      if (b < 0x20 || b > 0x7E) return [];
      text += String.fromCharCode(b);
      p++;
    }
    if (p >= top) return [];
    p++;   // the CR
    lines.push({ lineNumber: number, text: text.replace(/^ /, '') });
  }
  return lines;
}

/**
 * The 26 integer variables and any live FOR loops. Every letter exists (the
 * language has a fixed 26-word workspace), so a variable that was set to zero
 * is still listed — hiding it would misreport the machine.
 */
export function systemBasicVariables(mem: AcornSystemMemory): BasicVariable[] {
  if (!mem.basicFitted) return [];
  const out: BasicVariable[] = [];
  const inLoop = new Set<number>();

  const forCount = Math.min(FOR_LEVELS, mem.peekByte(FORCNT));
  for (let level = 0; level < forCount; level++) {
    const index = mem.peekByte(FORVAR + level) - 1;
    if (index < 0 || index >= 26) continue;
    inLoop.add(index);
    out.push({
      name: LETTERS[index],
      kind: 'for-next',
      value: String(readInt(mem, index)),
      detail: `TO ${readLong(mem, FORTOA, level)} STEP ${readLong(mem, STEPA, level)}`,
    });
  }

  for (let index = 0; index < 26; index++) {
    if (inLoop.has(index)) continue;
    out.push({ name: LETTERS[index], kind: 'number', value: String(readInt(mem, index)) });
  }
  return out;
}
