/**
 * The C128 BASIC V7.0 parser, against hand-built memory images and, with the
 * Commodore ROMs on hand, against what the real interpreter leaves in RAM:
 * the program in block 0, the variables and strings in block 1, and the FOR
 * loops on BASIC 7's own stack.
 */

import { describe, it, expect } from 'vitest';
import { parseC128Basic, parseC128BasicVariables } from '@/basic/c128-basic-parser.ts';
import { C128Machine } from '@/machines/c128/c128-machine.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';

const BLOCK1 = 0x10000;

/** A 128K image with a program at $1C01 (block 0) and the pointers set for it. */
function image(program: number[]): Uint8Array {
  const ram = new Uint8Array(0x20000);
  ram.set(program, 0x1C01);
  const put = (at: number, v: number) => { ram[at] = v & 0xFF; ram[at + 1] = v >> 8; };
  put(0x2D, 0x1C01); put(0x2F, 0x0400); put(0x31, 0x0400); put(0x33, 0x0400);
  return ram;
}

/** One program line: link filled in from where it will sit. */
function line(at: number, number: number, body: number[]): number[] {
  const next = at + 5 + body.length;
  return [next & 0xFF, next >> 8, number & 0xFF, number >> 8, ...body, 0];
}

const text = (s: string): number[] => [...s].map(c => c.charCodeAt(0));

describe('C128 BASIC 7.0 listing', () => {
  it('detokenises a program held in block 0', () => {
    const a = line(0x1C01, 10, [0x99, 0x22, ...text('HI'), 0x22, 0x3B, 0x41]);      // PRINT"HI";A
    const b = line(0x1C01 + a.length, 20, [0xEB]);                                   // DO
    const ram = image([...a, ...b, 0, 0]);
    expect(parseC128Basic(ram)).toEqual([
      { lineNumber: 10, text: 'PRINT"HI";A' },
      { lineNumber: 20, text: 'DO' },
    ]);
  });

  it('spells the BASIC 7.0 keywords, including the $CE and $FE escapes', () => {
    const a = line(0x1C01, 10, [0xDE, ...text('1'), 0x2C, 0xCE, 0x08, 0x20, 0xFE, 0x02, ...text('1')]);
    const b = line(0x1C01 + a.length, 20, [0xF9, 0xFE, 0x25]);
    const ram = image([...a, ...b, 0, 0]);
    expect(parseC128Basic(ram).map(l => l.text)).toEqual(['GRAPHIC1,XOR BANK1', 'KEYFAST']);
  });

  it('keeps REM and DATA text and quoted strings as typed', () => {
    const a = line(0x1C01, 10, [0x8F, ...text(' PRINT'), 0x22, 0x80]);
    const b = line(0x1C01 + a.length, 20, [0x83, ...text('1,2'), 0x3A, 0x99]);
    const ram = image([...a, ...b, 0, 0]);
    expect(parseC128Basic(ram).map(l => l.text)).toEqual(['REM PRINT"{$80}', 'DATA1,2:PRINT']);
  });

  it('returns nothing when BASIC has not set its pointers', () => {
    expect(parseC128Basic(new Uint8Array(0x20000))).toEqual([]);
    expect(parseC128Basic(new Uint8Array(0x10000))).toEqual([]);
  });
});

describe('C128 BASIC 7.0 variables', () => {
  it('reads simple variables, strings and arrays from block 1', () => {
    const ram = image([0, 0, 0]);
    const put = (at: number, v: number) => { ram[at] = v & 0xFF; ram[at + 1] = v >> 8; };
    // A = 5, B$ = "HI" (text at $FE00), C% = 7
    ram.set([0x41, 0x00, 0x83, 0x20, 0, 0, 0], BLOCK1 + 0x400);
    ram.set([0x42, 0x80, 2, 0x00, 0xFE, 0, 0], BLOCK1 + 0x407);
    ram.set(text('HI'), BLOCK1 + 0xFE00);
    ram.set([0xC3, 0x80, 0x00, 0x07, 0, 0, 0], BLOCK1 + 0x40E);
    // D(2,3): only the header matters, but the length has to chain to the end.
    ram.set([0x44, 0x00, 0x00, 0x00, 0x02, 0x00, 0x04, 0x00, 0x03], BLOCK1 + 0x415);
    const arrayLen = 5 + 4 + 12 * 5;
    ram[BLOCK1 + 0x417] = arrayLen & 0xFF; ram[BLOCK1 + 0x418] = arrayLen >> 8;
    put(0x2F, 0x400); put(0x31, 0x415); put(0x33, 0x415 + arrayLen);
    expect(parseC128BasicVariables(ram)).toEqual([
      { name: 'A', kind: 'number', value: '5' },
      { name: 'B$', kind: 'string', value: 'HI' },
      { name: 'C%', kind: 'number', value: '7' },
      { name: 'D(2,3)', kind: 'array' },
    ]);
  });
});

const REAL = 'c128-dev/';
const basicLo = romImage(REAL + 'basiclo');
const basicHi = romImage(REAL + 'basichi');
const kernal = romImage(REAL + 'kernal');
const chargen = romImage(REAL + 'chargen');
const haveRoms = !!(basicLo && basicHi && kernal && chargen);

function realC128(): C128Machine {
  const m = new C128Machine(null);
  m.loadRoms(basicLo, basicHi, kernal, chargen);
  m.reset();
  for (let f = 0; f < 150; f++) m.tick();
  return m;
}

function typeText(m: C128Machine, s: string): void {
  for (const ch of s) {
    const ev = ch === '\n'
      ? { code: 'Enter', key: 'Enter', shift: false, ctrl: false, alt: false }
      : { code: '', key: ch, shift: false, ctrl: false, alt: false };
    m.services.input.keyDown(ev);
    for (let f = 0; f < 3; f++) m.tick();
    m.services.input.keyUp(ev);
    for (let f = 0; f < (ch === '\n' ? 10 : 2); f++) m.tick();
  }
}

describe.skipIf(!haveRoms)('C128 BASIC parsers against the real interpreter', () => {
  it('lists a typed program and reads back what it ran', { timeout: 120_000 }, () => {
    const m = realC128();
    typeText(m, [
      '10 REM HELLO',
      '20 A=3.5:B%=-7:C$="HEY":N=1E10:S=.001',
      '30 DIM D(2,3),E$(4),F%(5):E$(2)="YO"',
      '40 PRINT "HI";A:DATA 1,"X":GOTO 60',
      '50 BANK 1:SOUND 1,2,3:FAST',
      '60 DO:STOP',
      'RUN',
      '',
    ].join('\n'));
    for (let f = 0; f < 300; f++) m.tick();
    const ram = m.memory.ram;
    expect(parseC128Basic(ram).map(l => `${l.lineNumber} ${l.text}`)).toEqual([
      '10 REM HELLO',
      '20 A=3.5:B%=-7:C$="HEY":N=1E10:S=.001',
      '30 DIM D(2,3),E$(4),F%(5):E$(2)="YO"',
      '40 PRINT "HI";A:DATA 1,"X":GOTO 60',
      '50 BANK 1:SOUND 1,2,3:FAST',
      '60 DO:STOP',
    ]);
    expect(parseC128BasicVariables(ram)).toEqual(expect.arrayContaining([
      { name: 'A', kind: 'number', value: '3.5' },
      { name: 'B%', kind: 'number', value: '-7' },
      { name: 'C$', kind: 'string', value: 'HEY' },
      { name: 'N', kind: 'number', value: '1E+10' },
      { name: 'S', kind: 'number', value: '1E-03' },
      { name: 'D(2,3)', kind: 'array' },
      { name: 'E$(4)', kind: 'array' },
      { name: 'F%(5)', kind: 'array' },
    ]));
    m.destroy();
  });

  it('shows the FOR loops in progress, innermost first, under a GOSUB and a DO', { timeout: 120_000 }, () => {
    const m = realC128();
    typeText(m, [
      '5 GOSUB 100:END',
      '100 FOR I=1 TO 10 STEP 2',
      '105 DO',
      '110 FOR J=5 TO 1 STEP -1.5',
      '120 GOTO 120',
      'RUN',
      '',
    ].join('\n'));
    for (let f = 0; f < 300; f++) m.tick();
    const loops = parseC128BasicVariables(m.memory.ram).filter(v => v.kind === 'for-next');
    expect(loops).toEqual([
      { name: 'J', kind: 'for-next', value: '5', detail: 'TO 1 STEP -1.5' },
      { name: 'I', kind: 'for-next', value: '1', detail: 'TO 10 STEP 2' },
    ]);
    m.destroy();
  });

  it('shows no loops when none is running', { timeout: 120_000 }, () => {
    const m = realC128();
    typeText(m, '10 A=1\n');
    expect(parseC128BasicVariables(m.memory.ram).filter(v => v.kind === 'for-next')).toEqual([]);
    expect(parseC128Basic(m.memory.ram)).toEqual([{ lineNumber: 10, text: 'A=1' }]);
    m.destroy();
  });
});
