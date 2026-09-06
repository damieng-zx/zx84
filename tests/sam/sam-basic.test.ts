/**
 * SAM BASIC program and variable parsing.
 *
 * The fixtures are the byte sequences a real SAM produced for the programs
 * named in each test, read out of RAM page 0 with the emulator running the
 * 3.0 ROM. They pin the three things the manual either states obliquely or
 * gets wrong:
 *
 *  - the line header is line number BIG-endian, then length little-endian;
 *  - the numeric-variable chain is measured from the HIGH byte of each offset,
 *    and a variable's name omits its own first letter (the letter index
 *    supplies it);
 *  - a string/array entry's length counts the payload only, not the three
 *    length bytes the manual says it includes.
 */

import { describe, expect, it } from 'vitest';
import {
  parseSamBasic, parseSamBasicVariables, parseSamProgram,
  parseSamNumericVars, parseSamStringVars, samBasicAnchors,
  type SamPageReader,
} from '@/basic/sam-basic-parser.ts';

const PAGE = 0x4000;

/** A page-space reader over a sparse map of pages. */
function reader(pages: Record<number, Uint8Array>): SamPageReader {
  return (page, offset) => pages[page]?.[offset] ?? 0xFF;
}

function page(bytes: Record<number, number[]>): Uint8Array {
  const p = new Uint8Array(PAGE).fill(0xFF);
  for (const [at, data] of Object.entries(bytes)) p.set(data, Number(at));
  return p;
}

/** Write a 3-byte page/offset pointer, the offset stored 0x8000-based. */
function ptr(p: Uint8Array, addr: number, pg: number, offset: number): void {
  const at = addr - 0x4000;
  const raw = 0x8000 + offset;
  p[at] = pg;
  p[at + 1] = raw & 0xFF;
  p[at + 2] = raw >> 8;
}

describe('parseSamProgram', () => {
  it('reads a line: big-endian number, little-endian length', () => {
    // 10 PRINT "hi"
    const p = page({ 0x1000: [0x00, 0x0A, 0x06, 0x00, 0xBB, 0x22, 0x68, 0x69, 0x22, 0x0D, 0xFF] });
    const lines = parseSamProgram(reader({ 0: p }), { page: 0, offset: 0x1000 });
    expect(lines).toEqual([{ lineNumber: 10, text: 'PRINT "hi"' }]);
  });

  it('skips the invisible five-byte form of a literal', () => {
    // 20 LET a=42 — the digits are stored, then 0x0E and the float.
    const p = page({
      0x1000: [0x00, 0x14, 0x0C, 0x00, 0x9C, 0x61, 0x3D, 0x34, 0x32,
        0x0E, 0x00, 0x00, 0x2A, 0x00, 0x00, 0x0D, 0xFF],
    });
    const lines = parseSamProgram(reader({ 0: p }), { page: 0, offset: 0x1000 });
    expect(lines[0].text).toBe('LET a=42');
  });

  it('spaces keywords apart only where a word needs separating', () => {
    // 40 FOR i=1 TO 5 — TO (0x8E) needs a space each side, "=" needs none.
    const p = page({
      0x1000: [0x00, 0x28, 0x13, 0x00, 0xC0, 0x69, 0x3D, 0x31,
        0x0E, 0x00, 0x00, 0x01, 0x00, 0x00,
        0x8E, 0x35, 0x0E, 0x00, 0x00, 0x05, 0x00, 0x00, 0x0D, 0xFF],
    });
    const lines = parseSamProgram(reader({ 0: p }), { page: 0, offset: 0x1000 });
    expect(lines[0].text).toBe('FOR i=1 TO 5');
  });

  it('decodes two-byte function tokens', () => {
    // PRINT SIN 1  — functions are 0xFF then 0x3B-0x84.
    const p = page({
      0x1000: [0x00, 0x0A, 0x0B, 0x00, 0xBB, 0xFF, 0x53, 0x31,
        0x0E, 0x00, 0x00, 0x01, 0x00, 0x00, 0x0D, 0xFF],
    });
    const lines = parseSamProgram(reader({ 0: p }), { page: 0, offset: 0x1000 });
    expect(lines[0].text).toBe('PRINT SIN 1');
  });

  it('leaves token bytes inside quotes as characters', () => {
    // A UDG code inside a string must not list as a keyword.
    const p = page({ 0x1000: [0x00, 0x0A, 0x05, 0x00, 0xBB, 0x22, 0x9C, 0x22, 0x0D, 0xFF] });
    const lines = parseSamProgram(reader({ 0: p }), { page: 0, offset: 0x1000 });
    expect(lines[0].text).toBe('PRINT "{9C}"');
  });

  it('follows the program across a page boundary', () => {
    const p0 = page({ 0x3FF8: [0x00, 0x0A, 0x06, 0x00, 0xBB, 0x22, 0x68, 0x69] });
    const p1 = page({ 0x0000: [0x22, 0x0D, 0xFF] });
    const lines = parseSamProgram(reader({ 0: p0, 1: p1 }), { page: 0, offset: 0x3FF8 });
    expect(lines).toEqual([{ lineNumber: 10, text: 'PRINT "hi"' }]);
  });

  it('stops at the 0xFF end marker', () => {
    const p = page({
      0x1000: [0x00, 0x0A, 0x02, 0x00, 0xAF, 0x0D, 0xFF, 0x00, 0x14, 0x02, 0x00, 0xB0, 0x0D],
    });
    const lines = parseSamProgram(reader({ 0: p }), { page: 0, offset: 0x1000 });
    expect(lines.map(l => l.lineNumber)).toEqual([10]);
  });

  it('gives up rather than inventing lines when the pointer is not a program', () => {
    const p = page({});   // all 0xFF
    expect(parseSamProgram(reader({ 0: p }), { page: 0, offset: 0x1000 })).toEqual([]);
  });
});

describe('parseSamNumericVars', () => {
  /** The 26-entry letter table plus a chain, as SAM BASIC lays it out. */
  function numericArea(entries: Record<number, number>, records: Record<number, number[]>): Uint8Array {
    const area: number[] = [];
    for (let i = 0; i < 26; i++) {
      const v = entries[i] ?? 0xFFFF;
      area.push(v & 0xFF, v >> 8);
    }
    const p = page({ 0x1000: area });
    for (const [at, bytes] of Object.entries(records)) p.set(bytes, 0x1000 + Number(at));
    return p;
  }

  it('takes a one-letter name from the letter index, not the record', () => {
    // 'a' = 42. Type 0x00 -> name length 1, so no characters are stored.
    const p = numericArea({ 0: 0x005B }, {
      // entry 0's high byte is at +1, so the record sits at 1 + 0x5B.
      0x5C: [0x00, 0xFF, 0xFF, 0x00, 0x00, 0x2A, 0x00, 0x00],
    });
    expect(parseSamNumericVars(reader({ 0: p }), { page: 0, offset: 0x1000 }))
      .toEqual([{ name: 'a', kind: 'number', value: '42' }]);
  });

  it('appends the stored characters to the indexed first letter', () => {
    // 'banana' = 7. Type 0x05 -> six characters, five of them stored.
    const p = numericArea({ 1: 0x0061 }, {
      0x64: [0x05, 0xFF, 0xFF, 0x61, 0x6E, 0x61, 0x6E, 0x61, 0x00, 0x00, 0x07, 0x00, 0x00],
    });
    expect(parseSamNumericVars(reader({ 0: p }), { page: 0, offset: 0x1000 }))
      .toEqual([{ name: 'banana', kind: 'number', value: '7' }]);
  });

  it('reads a FOR-NEXT variable with its limit and step', () => {
    const p = numericArea({ 8: 0x0060 }, {
      0x71: [0x40, 0xFF, 0xFF,
        0x00, 0x00, 0x06, 0x00, 0x00,      // value 6
        0x00, 0x00, 0x05, 0x00, 0x00,      // limit 5
        0x00, 0x00, 0x01, 0x00, 0x00],     // step 1
    });
    expect(parseSamNumericVars(reader({ 0: p }), { page: 0, offset: 0x1000 }))
      .toEqual([{ name: 'i', kind: 'for-next', value: '6', detail: 'TO 5 STEP 1' }]);
  });

  it('decodes the exponent form of the five-byte float', () => {
    // 0.5 = exponent 0x80, mantissa 0x00000000 (implied leading 1).
    const p = numericArea({ 7: 0x0060 }, {
      0x6F: [0x00, 0xFF, 0xFF, 0x80, 0x00, 0x00, 0x00, 0x00],
    });
    const vars = parseSamNumericVars(reader({ 0: p }), { page: 0, offset: 0x1000 });
    expect(vars[0].value).toBe('0.5');
  });

  it('reads a negative small integer', () => {
    const p = numericArea({ 13: 0x0060 }, {
      0x7B: [0x00, 0xFF, 0xFF, 0x00, 0xFF, 0xFE, 0xFF, 0x00],
    });
    expect(parseSamNumericVars(reader({ 0: p }), { page: 0, offset: 0x1000 })[0].value).toBe('-2');
  });

  it('follows the chain from each offset high byte', () => {
    // Two variables starting with 'a', chained.
    const p = numericArea({ 0: 0x005B }, {
      0x5C: [0x00, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00],
      // next = record start + 2 + 0x10
      0x6E: [0x01, 0xFF, 0xFF, 0x62, 0x00, 0x00, 0x02, 0x00, 0x00],
    });
    expect(parseSamNumericVars(reader({ 0: p }), { page: 0, offset: 0x1000 })
      .map(v => `${v.name}=${v.value}`)).toEqual(['a=1', 'ab=2']);
  });

  it('hides variables marked hidden or out of use', () => {
    const p = numericArea({ 0: 0x005B }, {
      0x5C: [0x20, 0xFF, 0xFF, 0x00, 0x00, 0x01, 0x00, 0x00],   // bit 5 = dead
    });
    expect(parseSamNumericVars(reader({ 0: p }), { page: 0, offset: 0x1000 })).toEqual([]);
  });
});

describe('parseSamStringVars', () => {
  it('reads a string whose length counts the payload only', () => {
    // z$ = "hello": type 0x01, ten name bytes, then 00 05 00, then the text.
    const p = page({
      0x1000: [0x01, 0x7A, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0x00, 0x05, 0x00,
        0x68, 0x65, 0x6C, 0x6C, 0x6F, 0xFF],
    });
    expect(parseSamStringVars(reader({ 0: p }), { page: 0, offset: 0x1000 }))
      .toEqual([{ name: 'z$', kind: 'string', value: 'hello' }]);
  });

  it('names an array with its dimensions', () => {
    // q(3): type 0x21 (numeric array), payload 18 = 1 dim byte + 2 bound + 3x5.
    const data = [0x01, 0x03, 0x00];
    for (let i = 0; i < 15; i++) data.push(0x00);
    const p = page({
      0x1000: [0x21, 0x71, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0x00, 0x12, 0x00, ...data, 0xFF],
    });
    expect(parseSamStringVars(reader({ 0: p }), { page: 0, offset: 0x1000 }))
      .toEqual([{ name: 'q(3)', kind: 'array', detail: '= 0, 0, 0' }]);
  });

  it('marks a string array with its $ and both bounds', () => {
    const data = [0x02, 0x02, 0x00, 0x04, 0x00, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20];
    const p = page({
      0x1000: [0x41, 0x6E, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0x00, 0x0D, 0x00, ...data, 0xFF],
    });
    expect(parseSamStringVars(reader({ 0: p }), { page: 0, offset: 0x1000 }))
      .toEqual([{ name: 'n$(2,4)', kind: 'array', detail: '= "", ""' }]);
  });

  it('previews a numeric array\'s elements', () => {
    // q(3) = 11, 9, 0 — three 5-byte values after the dimension header.
    const data = [0x01, 0x03, 0x00,
      0x00, 0x00, 0x0B, 0x00, 0x00,
      0x00, 0x00, 0x09, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00];
    const p = page({
      0x1000: [0x21, 0x71, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x12, 0x00, ...data, 0xFF],
    });
    expect(parseSamStringVars(reader({ 0: p }), { page: 0, offset: 0x1000 }))
      .toEqual([{ name: 'q(3)', kind: 'array', detail: '= 11, 9, 0' }]);
  });

  it('reads a string array\'s LAST bound as the string length, not an axis', () => {
    // n$(2,4) is two four-character strings — eight bytes — exactly as
    // Sinclair BASIC declares them. Counting the 4 as an axis would report
    // eight elements where there are two.
    const text = [...'ab  cd  '].map(ch => ch.charCodeAt(0));
    const data = [0x02, 0x02, 0x00, 0x04, 0x00, ...text];
    const p = page({
      0x1000: [0x41, 0x6E, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x0D, 0x00, ...data, 0xFF],
    });
    expect(parseSamStringVars(reader({ 0: p }), { page: 0, offset: 0x1000 }))
      .toEqual([{ name: 'n$(2,4)', kind: 'array', detail: '= "ab", "cd"' }]);
  });

  it('trails off rather than listing a large array in full', () => {
    const data = [0x01, 0x28, 0x00, ...new Array(40 * 5).fill(0x00)];
    const p = page({
      0x1000: [0x21, 0x62, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0xCB, 0x00, ...data, 0xFF],
    });
    const [v] = parseSamStringVars(reader({ 0: p }), { page: 0, offset: 0x1000 });
    expect(v.name).toBe('b(40)');
    expect(v.detail).toBe('= 0, 0, 0, 0, 0, 0, 0, 0, …');
  });

  it('walks on to the entry after a string', () => {
    const p = page({
      0x1000: [
        0x01, 0x7A, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x02, 0x00, 0x68, 0x69,
        0x01, 0x79, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x02, 0x00, 0x6F, 0x6B,
        0xFF,
      ],
    });
    expect(parseSamStringVars(reader({ 0: p }), { page: 0, offset: 0x1000 })
      .map(v => `${v.name}=${v.value}`)).toEqual(['z$=hi', 'y$=ok']);
  });
});

describe('samBasicAnchors', () => {
  it('folds a 0x8000-based offset back into a page and an offset', () => {
    const p = page({});
    ptr(p, 0x5A9F, 3, 0x1CD5);     // PROG
    ptr(p, 0x5A87, 3, 0x1D28);     // NVARS
    ptr(p, 0x5A81, 3, 0x1F84);     // SAVARS
    expect(samBasicAnchors(reader({ 0: p }))).toEqual({
      prog: { page: 3, offset: 0x1CD5 },
      nvars: { page: 3, offset: 0x1D28 },
      savars: { page: 3, offset: 0x1F84 },
    });
  });

  it('carries an offset that runs past its own page into the next one', () => {
    // 0xC100 is one page beyond the 0x8000 window's first page.
    const p = page({});
    p[0x5A9F - 0x4000] = 5;
    p[0x5AA0 - 0x4000] = 0x00;
    p[0x5AA1 - 0x4000] = 0xC1;
    expect(samBasicAnchors(reader({ 0: p })).prog).toEqual({ page: 6, offset: 0x0100 });
  });

  it('reports no anchors at all while the sysvars are still zero', () => {
    // The state for the first few seconds of every cold boot, while the ROM
    // runs its RAM test. A 0 offset is not a pointer: the stored form is
    // 0x8000-based, so the lowest legal value is 0x8000.
    const zeroed = new Uint8Array(PAGE);
    expect(samBasicAnchors(reader({ 0: zeroed }))).toEqual({
      prog: null, nvars: null, savars: null,
    });
  });

  it('shows nothing rather than inventing a program and 13,312 variables', () => {
    // Taking a zeroed page at face value aimed every walker at page 0 offset 0
    // and marched them through blank RAM: each of the 26 letter chains stepped
    // two bytes at a time to its iteration cap, one "variable = 0" apiece.
    const zeroed = new Uint8Array(PAGE);
    const read = reader({ 0: zeroed });
    expect(parseSamBasic(read)).toEqual([]);
    expect(parseSamBasicVariables(read)).toEqual([]);
  });

  it('ignores a letter chain pointing back inside the letter table', () => {
    // Every variable lives past the 52-byte table, so a head that lands inside
    // it is uninitialised memory, not a chain.
    const p = page({ 0x1000: new Array(52).fill(0x00) });
    ptr(p, 0x5A87, 0, 0x1000);
    ptr(p, 0x5A81, 0, 0x1100);
    p[0x1100] = 0xFF;
    expect(parseSamBasicVariables(reader({ 0: p }))).toEqual([]);
  });

  it('drives the pane entry points end to end', () => {
    const p = page({
      0x1000: [0x00, 0x0A, 0x02, 0x00, 0xAF, 0x0D, 0xFF],
      0x2000: new Array(52).fill(0xFF),
      0x3000: [0xFF],
    });
    ptr(p, 0x5A9F, 0, 0x1000);
    ptr(p, 0x5A87, 0, 0x2000);
    ptr(p, 0x5A81, 0, 0x3000);
    const read = reader({ 0: p });
    expect(parseSamBasic(read)).toEqual([{ lineNumber: 10, text: 'NEW' }]);
    expect(parseSamBasicVariables(read)).toEqual([]);
  });
});
