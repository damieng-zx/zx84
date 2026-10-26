/**
 * Atari BASIC listing and variables panes.
 *
 * Expectations (Atari BASIC Reference Manual, appendices; The Atari BASIC
 * Source Book, ch. 2-3 and the LIST chapter):
 *  - zero page holds LOMEM $80, VNTP $82, VNTD $84, VVTP $86, STMTAB $88,
 *    STMCUR $8A, STARP $8C, RUNSTK $8E and MEMTOP $90, the areas in that
 *    order; the name table ends in a zero byte at VNTD and the value table
 *    follows it;
 *  - a line is its number, its length, then statements of (offset to the
 *    next statement, statement token, tokens), the last ending in the EOL
 *    operator $16 and the others in `:` ($14); the direct-mode line is 32768;
 *  - names end in a byte with bit 7 set: `$` strings, `(` arrays, whose
 *    array-paren token then lists as nothing; implied LET lists no keyword;
 *    LIST puts a blank after a statement keyword and around word operators;
 *  - value-table entries are type, number and 6 bytes: a BCD float ($40 01
 *    is 1, the sign in bit 7, the exponent a power of 100 in excess 64), or
 *    a STARP offset with the length and DIM size (strings) or the two DIM
 *    extents + 1 (arrays); bit 0 of the type is set once DIMensioned.
 *  - real-ROM cases: a program typed into BASIC lists in the pane exactly as
 *    BASIC's own LIST prints it, and each variable reads as PRINT shows it.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';
import {
  decodeAtariFloat, isAtariBasicRom, parseAtariBasic, parseAtariBasicVariables,
} from '@/basic/atari-basic-parser.ts';

const ch = (s: string): number[] => [...s].map(c => c.charCodeAt(0));
/** A name as the VNT holds it: bit 7 set on its last character. */
const vname = (s: string): number[] => ch(s).map((c, i) => (i === s.length - 1 ? c | 0x80 : c));
/** A whole-number float constant token ($0E + 6 BCD bytes), below 100. */
const small = (n: number): number[] => [0x0E, 0x40, (Math.floor(n / 10) << 4) | (n % 10), 0, 0, 0, 0];

function fp(...bytes: number[]): string | null {
  const b = new Uint8Array(6);
  b.set(bytes);
  return decodeAtariFloat(b, 0);
}

describe('Atari BASIC floating point', () => {
  it('decodes excess-64 powers of 100 with the sign in bit 7', () => {
    expect(fp(0, 0, 0, 0, 0, 0)).toBe('0');
    expect(fp(0x40, 0x01)).toBe('1');
    expect(fp(0x41, 0x01)).toBe('100');
    expect(fp(0x40, 0x03, 0x50)).toBe('3.5');
    expect(fp(0x3F, 0x50)).toBe('0.5');
    expect(fp(0xC1, 0x01, 0x23, 0x45)).toBe('-123.45');
    expect(fp(0x3F, 0x01)).toBe('0.01');
    expect(fp(0x44, 0x99, 0x99, 0x99, 0x99, 0x99)).toBe('9999999999');
    expect(fp(0x40, 0x03, 0x14, 0x15, 0x92, 0x65)).toBe('3.14159265');
  });

  it('prints below 0.01 and from 1E10 with a two-digit exponent', () => {
    expect(fp(0x3E, 0x01)).toBe('1E-04');
    expect(fp(0x45, 0x01)).toBe('1E+10');
    expect(fp(0x45, 0x01, 0x50)).toBe('1.5E+10');
    expect(fp(0x3D, 0x12, 0x50)).toBe('1.25E-05');
    expect(fp(0xD6, 0x01)).toBe('-1E+44');
    // A two-digit leading byte moves the point left: the OS's FASC keeps
    // the digit that crosses it, so 0.005 is 5.0E-03, not 5E-03.
    expect(fp(0x3E, 0x50)).toBe('5.0E-03');
    expect(fp(0x70, 0x10)).toBe('1.0E+97');
  });

  it('rejects bytes that are not BCD', () => {
    expect(fp(0x40, 0x1A)).toBeNull();
    expect(fp(0x40, 0x01, 0xF0)).toBeNull();
  });
});

// ── Hand-built program ──────────────────────────────────────────────────────

const LOMEM = 0x0700;
const VNTP = 0x0800;

/** Program lines as [number, statements], each statement [token, ...body]. */
type Line = [number, number[][]];

/**
 * Lay out a program as BASIC does: the name table at VNTP, the value table,
 * the statement table ending in the direct-mode line, then the string/array
 * area. Returns the 64K space and where each area landed.
 */
function program(names: string[], values: number[][], lines: Line[], strings: number[]) {
  const mem = new Uint8Array(0x10000);
  let a = VNTP;
  for (const n of names) for (const b of vname(n)) mem[a++] = b;
  const vntd = a;
  mem[a++] = 0;
  const vvtp = a;
  values.forEach((v, i) => { mem.set([v[0], i, ...v.slice(1)], a); a += 8; });
  const stmtab = a;
  const all: Line[] = [...lines, [0x8000, [[21]]]]; // the direct line: END
  for (const [num, stmts] of all) {
    const start = a;
    mem[a] = num & 0xFF;
    mem[a + 1] = num >> 8;
    a += 3;
    stmts.forEach((s, i) => {
      const body = [...s, i === stmts.length - 1 ? 0x16 : 0x14];
      mem[a] = a - start + 1 + body.length;
      mem.set(body, a + 1);
      a += 1 + body.length;
    });
    mem[start + 2] = a - start;
  }
  const starp = a;
  mem.set(strings, starp);
  const runstk = starp + strings.length;
  const w = (addr: number, v: number) => { mem[addr] = v & 0xFF; mem[addr + 1] = v >> 8; };
  w(0x80, LOMEM); w(0x82, VNTP); w(0x84, vntd); w(0x86, vvtp); w(0x88, stmtab);
  w(0x8A, stmtab); w(0x8C, starp); w(0x8E, runstk); w(0x90, runstk);
  return { mem, vvtp, stmtab, starp };
}

/** A, S$, B( and LONG: a scalar 3.5, S$ DIMed 10 holding HELLO, B DIMed 3,
 *  LONG never assigned. */
function sample() {
  const strings = [...ch('HELLO'), 0, 0, 0, 0, 0, ...new Array(24).fill(0)];
  return program(
    ['A', 'S$', 'B(', 'LONG'],
    [
      [0x00, 0x40, 0x03, 0x50, 0, 0, 0],
      [0x81, 0, 0, 5, 0, 10, 0],
      [0x41, 10, 0, 4, 0, 1, 0],
      [0x00, 0, 0, 0, 0, 0, 0],
    ],
    [
      [10, [[0x00, ...ch('HI THERE'), 0x9B]]],                                  // REM
      [20, [[0x20, 0x0F, 5, ...ch('HELLO'), 0x15, 0x80]]],                      // PRINT
      [30, [[0x36, 0x80, 0x2D, 0x0E, 0x3F, 0x50, 0, 0, 0, 0],                   // implied LET
        [0x36, 0x81, 0x2E, 0x0F, 3, ...ch('ABC')]]],
      [40, [[0x08, 0x80, 0x2D, ...small(1), 0x19, ...small(10), 0x1A, ...small(2)]]], // FOR
      [50, [[0x07, 0x80, 0x21, 0x82, 0x38, ...small(1), 0x2C, 0x1B, ...small(10)]]],  // IF
      [60, [[0x14, 0x81, 0x3B, ...small(10), 0x2C, 0x12, 0x82, 0x39, ...small(3), 0x2C]]], // DIM
      [70, [[0x0B, ...small(10)]]],                                             // GO TO
      [80, [[0x20, 0x46, 0x3A, 0x0E, 0x41, 0x01, 0x06, 0, 0, 0, 0x2C, 0x24, ...small(2)]]], // PEEK
      [90, [[0x1E, 0x83, 0x18, ...small(10), 0x12, ...small(20)]]],             // ON GOSUB
      [100, [[0x06, 0x83, 0x2D, 0x36, 0x80, 0x29, 0x28, 0x83]]],                 // LET, unary -, OR, NOT
    ],
    strings,
  );
}

describe('Atari BASIC listing (hand-built tables)', () => {
  it('detokenises statements, operators, functions, constants and names', () => {
    expect(parseAtariBasic(sample().mem)).toEqual([
      { lineNumber: 10, text: 'REM HI THERE' },
      { lineNumber: 20, text: 'PRINT "HELLO";A' },
      { lineNumber: 30, text: 'A=0.5:S$="ABC"' },
      { lineNumber: 40, text: 'FOR A=1 TO 10 STEP 2' },
      { lineNumber: 50, text: 'IF A>B(1) THEN 10' },
      { lineNumber: 60, text: 'DIM S$(10),B(3)' },
      { lineNumber: 70, text: 'GO TO 10' },
      { lineNumber: 80, text: 'PRINT PEEK(106)*2' },
      { lineNumber: 90, text: 'ON LONG GOSUB 10,20' },
      { lineNumber: 100, text: 'LET LONG=-A OR  NOT LONG' },
    ]);
  });

  it('lists a syntax-error line as ERROR- and its raw text', () => {
    const { mem } = program([], [], [[10, [[0x37, ...ch('PRUNT '), 0x35 | 0x80, 0x9B]]]], []);
    expect(parseAtariBasic(mem)).toEqual([{ lineNumber: 10, text: 'ERROR-   PRUNT 5' }]);
  });

  it('is empty for a NEW program and for memory BASIC has not set up', () => {
    expect(parseAtariBasic(program([], [], [], []).mem)).toEqual([]);
    expect(parseAtariBasic(new Uint8Array(0x10000))).toEqual([]);
  });

  it('shows nothing rather than garbage when the tables do not hold together', () => {
    const outOfOrder = sample();
    outOfOrder.mem[0x83] = 0x06; // VNTP below LOMEM
    expect(parseAtariBasic(outOfOrder.mem)).toEqual([]);

    const renumbered = sample();
    renumbered.mem[renumbered.vvtp + 8 + 1] = 7; // S$'s entry claims number 7
    expect(parseAtariBasic(renumbered.mem)).toEqual([]);
    expect(parseAtariBasicVariables(renumbered.mem)).toEqual([]);

    const badLength = sample();
    badLength.mem[badLength.stmtab + 3] = 0xF0; // first statement runs past its line
    expect(parseAtariBasic(badLength.mem)).toEqual([]);

    const badToken = sample();
    badToken.mem[badToken.stmtab + 4] = 0x40; // no statement 64
    expect(parseAtariBasic(badToken.mem)).toEqual([]);

    const unknownVar = sample();
    const line20 = unknownVar.stmtab + unknownVar.mem[unknownVar.stmtab + 2];
    unknownVar.mem[line20 + 13] = 0x90; // variable 16 of 4
    expect(parseAtariBasic(unknownVar.mem)).toEqual([]);
  });
});

describe('Atari BASIC variables (hand-built tables)', () => {
  it('reads scalars, strings from STARP and DIMensioned arrays', () => {
    expect(parseAtariBasicVariables(sample().mem)).toEqual([
      { name: 'A', kind: 'number', value: '3.5' },
      { name: 'S$', kind: 'string', value: 'HELLO' },
      { name: 'B(3)', kind: 'array' },
      { name: 'LONG', kind: 'number', value: '0' },
    ]);
  });

  it('marks strings and arrays not yet DIMensioned, and shows both array extents', () => {
    const { mem } = program(
      ['S$', 'B(', 'C('],
      [[0x80, 0, 0, 0, 0, 0, 0], [0x40, 0, 0, 0, 0, 0, 0], [0x41, 0, 0, 3, 0, 4, 0]],
      [],
      new Array(72).fill(0),
    );
    expect(parseAtariBasicVariables(mem)).toEqual([
      { name: 'S$', kind: 'string', value: '' },
      { name: 'B()', kind: 'array', detail: 'not dimensioned' },
      { name: 'C(2,3)', kind: 'array' },
    ]);
  });

  it('refuses a string longer than its DIM or outside the string area', () => {
    const tooLong = sample();
    tooLong.mem[tooLong.vvtp + 8 + 4] = 11; // length 11, DIM 10
    expect(parseAtariBasicVariables(tooLong.mem)).toEqual([]);
    const outside = sample();
    outside.mem[outside.vvtp + 8 + 3] = 0x10; // offset $1000
    expect(parseAtariBasicVariables(outside.mem)).toEqual([]);
  });
});

// ── Which ROM owns zero page ───────────────────────────────────────────────

/** An 8K stand-in for BASIC: just the head of its statement name table, each
 *  name preceded by a 2-byte syntax-table address. */
function fakeBasic(): Uint8Array {
  const rom = new Uint8Array(0x2000).fill(0xEA);
  rom.set([0x10, 0xA7, ...vname('REM'), 0x11, 0xA7, ...vname('DATA'), 0x12, 0xA7, ...vname('INPUT')], 0x04A0);
  rom.set([0x00, 0xA0, 0x00, 0x05, 0xF0, 0xBF], 0x1FFA);
  return rom;
}

describe('Atari BASIC residency', () => {
  it('recognises BASIC by its statement name table', () => {
    expect(isAtariBasicRom(fakeBasic())).toBe(true);
    expect(isAtariBasicRom(new Uint8Array(0x2000).fill(0xFF))).toBe(false);
  });

  it('also recognises Altirra BASIC, whose name table has no syntax addresses', () => {
    const rom = new Uint8Array(0x2000).fill(0xEA);
    rom.set([...vname('REM'), ...vname('DATA'), ...vname('INPUT')], 0x0305);
    expect(isAtariBasicRom(rom)).toBe(true);
  });

  it('lists only while a BASIC cartridge is in on the 800', () => {
    const m = new AtariMachine('atari800', null);
    try {
      const panes = m.services.probe.panes;
      const load = () => m.memory.ram.set(sample().mem.subarray(0, 0xA000));
      load();
      expect(panes.basicListing!()).toEqual([]);
      expect(panes.basicVars!()).toEqual([]);

      m.memory.insertCart(new Uint8Array(0x2000).fill(0x60)); // not BASIC
      expect(panes.basicListing!()).toEqual([]);

      m.memory.insertCart(fakeBasic());
      load();
      expect(panes.basicListing!()).toHaveLength(10);
      expect(panes.basicVars!()).toHaveLength(4);
    } finally {
      m.destroy();
    }
  });

  it('lists from the 800XL built-in BASIC only while PORTB enables it', () => {
    const m = new AtariMachine('atari800xl', null);
    try {
      m.memory.loadRom(new Uint8Array([...new Uint8Array(0x4000), ...fakeBasic()]));
      m.memory.ram.set(sample().mem.subarray(0, 0xA000));
      const panes = m.services.probe.panes;
      m.memory.setPortB(0xFF); // bit 1 high: BASIC off
      expect(panes.basicListing!()).toEqual([]);
      m.memory.setPortB(0xFD);
      expect(panes.basicListing!()).toHaveLength(10);
    } finally {
      m.destroy();
    }
  });
});

// ── Real ROMs ───────────────────────────────────────────────────────────────

const DIR = process.env.ATARI_ROM_DIR ?? resolve(__dirname, '../../mcp/.cache');
const OS = resolve(DIR, 'atariosb.rom');
const BASIC = resolve(DIR, 'ataribas.rom');
const XL_OS = ['atari800xl.rom', 'REV02.ROM'].map(n => resolve(DIR, n)).find(existsSync);
const haveRoms = existsSync(OS) && existsSync(BASIC);

function keyEvent(c: string): HostKeyEvent {
  const base = { shift: false, ctrl: false, alt: false };
  if (c === '\n') return { code: 'Enter', key: 'Enter', ...base };
  if (c === ' ') return { code: 'Space', key: ' ', ...base };
  if (/[A-Z]/.test(c)) return { code: `Key${c}`, key: c.toLowerCase(), ...base };
  if (/[0-9]/.test(c)) return { code: `Digit${c}`, key: c, ...base };
  return { code: 'Equal', key: c, ...base };
}

/** Type text; BASIC gets time after each RETURN to tokenise or run the line. */
function type(m: AtariMachine, text: string): void {
  for (const c of text) {
    const e = keyEvent(c);
    m.keyDown(e);
    for (let f = 0; f < 3; f++) m.tick();
    m.keyUp(e);
    for (let f = 0; f < (c === '\n' ? 30 : 3); f++) m.tick();
  }
}

/** The GRAPHICS 0 screen as text, one trimmed string per row. */
function rows(m: AtariMachine): string[] {
  const sav = m.memory.readByte(0x58) | (m.memory.readByte(0x59) << 8);
  const out: string[] = [];
  for (let r = 0; r < 24; r++) {
    let s = '';
    for (let c = 0; c < 40; c++) {
      const v = m.memory.readByte(sav + r * 40 + c) & 0x7f;
      const a = v < 0x40 ? v + 0x20 : v < 0x60 ? v - 0x40 : v;
      s += a >= 0x20 && a < 0x7f ? String.fromCharCode(a) : ' ';
    }
    out.push(s.trim());
  }
  return out;
}

/** The pane's listing as LIST would print it: `<number> <text>`. */
function paneListing(m: AtariMachine): string[] {
  return m.services.probe.panes.basicListing!().map(l => `${l.lineNumber} ${l.text}`);
}

/** Run LIST and return the rows it printed (each line fits one row). */
function screenListing(m: AtariMachine): string[] {
  type(m, 'LIST\n');
  const screen = rows(m);
  const from = screen.lastIndexOf('LIST') + 1;
  return screen.slice(from, screen.indexOf('READY', from)).filter(r => r !== '');
}

/** What `PRINT <expr>` shows on the next row. */
function printed(m: AtariMachine, expr: string): string {
  type(m, `PRINT ${expr}\n`);
  const screen = rows(m);
  return screen[screen.lastIndexOf(`PRINT ${expr}`) + 1];
}

const PROGRAM = [
  '10 REM PANE TEST',
  '20 DIM A$(12),B(5),C(2,3)',
  '30 A$="ATARI":B(1)=7:C(2,3)=-1.5',
  '40 X=355/113:Y=0.005:Z=1E10',
  '50 FOR I=1 TO 3 STEP 2:NEXT I',
  '60 IF NOT X THEN 10',
  '70 PRINT #6;STR$(PEEK(5)),A$(1,1)',
  '80 ON X GOSUB 90,90:PRUNT',
  '90 RETURN',
];

describe.skipIf(!haveRoms)('Atari BASIC panes with the real ROMs', { timeout: 60_000 }, () => {
  it('lists a typed program as LIST does, and its variables as PRINT does', () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.services.roms.installSystemRom(new Uint8Array(readFileSync(OS)));
      m.services.roms.cartridge!.insert(new Uint8Array(readFileSync(BASIC)), '');
      m.setSpeedMultiplier(0);
      for (let f = 0; f < 120; f++) m.tick();
      expect(paneListing(m)).toEqual([]);
      expect(m.services.probe.panes.basicVars!()).toEqual([]);

      // Line 80's PRUNT is a syntax error: BASIC keeps it as an ERROR- line.
      type(m, PROGRAM.slice(0, 7).join('\n') + '\n');
      type(m, '80 ON X GOSUB 90,90\n90 RETURN\nRUN\n');
      for (let f = 0; f < 30; f++) m.tick();

      const listed = screenListing(m);
      expect(listed).toHaveLength(9);
      expect(paneListing(m)).toEqual(listed);

      const vars = m.services.probe.panes.basicVars!();
      expect(vars.map(v => v.name)).toEqual(['A$', 'B(5)', 'C(2,3)', 'X', 'Y', 'Z', 'I']);
      for (const v of vars) {
        if (v.kind === 'number') expect(v.value).toBe(printed(m, v.name));
        if (v.kind === 'string') expect(v.value).toBe(printed(m, v.name));
      }
      expect(vars.find(v => v.name === 'A$')!.value).toBe('ATARI');

      type(m, 'NEW\n');
      expect(paneListing(m)).toEqual([]);
      expect(m.services.probe.panes.basicVars!()).toEqual([]);
    } finally {
      m.destroy();
    }
  });

  it.skipIf(!XL_OS)('lists from the 800XL built-in BASIC', () => {
    const m = new AtariMachine('atari800xl', null, 'pal');
    try {
      const os = new Uint8Array(readFileSync(XL_OS!));
      m.services.roms.installSystemRom(new Uint8Array([...os, ...readFileSync(BASIC)]));
      m.reset();
      m.setSpeedMultiplier(0);
      for (let f = 0; f < 150; f++) m.tick();
      type(m, '10 N=32*32:PRINT N\nRUN\n');
      expect(paneListing(m)).toEqual(screenListing(m));
      expect(paneListing(m)).toEqual(['10 N=32*32:PRINT N']);
      expect(m.services.probe.panes.basicVars!()).toEqual([{ name: 'N', kind: 'number', value: '1024' }]);
    } finally {
      m.destroy();
    }
  });
});
