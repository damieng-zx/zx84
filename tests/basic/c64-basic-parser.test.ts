/**
 * The C64 BASIC V2 parser, against hand-built memory images and, with the
 * Commodore ROMs on hand, against what the real interpreter leaves in RAM.
 */

import { describe, it, expect } from 'vitest';
import { formatC64Float, parseC64Basic, parseC64BasicVariables } from '@/basic/c64-basic-parser.ts';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';

/** A 64K image with a program at $0801 and the pointers set for it. */
function image(program: number[], vars: number[] = [], arrays: number[] = []): Uint8Array {
  const ram = new Uint8Array(0x10000);
  ram.set(program, 0x0801);
  const vartab = 0x0801 + program.length;
  const arytab = vartab + vars.length;
  ram.set(vars, vartab);
  ram.set(arrays, arytab);
  const put = (at: number, v: number) => { ram[at] = v & 0xFF; ram[at + 1] = v >> 8; };
  put(0x2B, 0x0801); put(0x2D, vartab); put(0x2F, arytab); put(0x31, arytab + arrays.length);
  return ram;
}

/** One program line: link filled in from where it will sit. */
function line(at: number, number: number, body: number[]): number[] {
  const next = at + 5 + body.length;
  return [next & 0xFF, next >> 8, number & 0xFF, number >> 8, ...body, 0];
}

const text = (s: string): number[] => [...s].map(c => c.charCodeAt(0));

describe('C64 BASIC listing', () => {
  it('detokenises a program', () => {
    const a = line(0x0801, 10, [0x99, 0x22, ...text('HI'), 0x22, 0x3B, 0x41]);      // PRINT"HI";A
    const b = line(0x0801 + a.length, 20, [0x89, ...text('10')]);                    // GOTO10
    const ram = image([...a, ...b, 0, 0]);
    expect(parseC64Basic(ram)).toEqual([
      { lineNumber: 10, text: 'PRINT"HI";A' },
      { lineNumber: 20, text: 'GOTO10' },
    ]);
  });

  it('leaves REM, DATA and quoted text as typed, and spells control codes like petcat', () => {
    const rem = line(0x0801, 1, [0x8F, ...text(' GOTO 5'), 0x80]);                  // a stray $80 after REM is not END
    const data = line(0x0801 + rem.length, 2, [0x83, ...text('1,"A"'), 0x3A, 0x80]);   // DATA 1,"A" : END
    const str = line(0x0801 + rem.length + data.length, 3, [0x99, 0x22, 0x93, 0x1C, 0x22]); // PRINT"{clr}{red}"
    const ram = image([...rem, ...data, ...str, 0, 0]);
    expect(parseC64Basic(ram).map(l => l.text)).toEqual([
      'REM GOTO 5{$80}',
      'DATA1,"A":END',
      'PRINT"{clr}{red}"',
    ]);
  });

  it('prints pi and the pound sign', () => {
    const ram = image([...line(0x0801, 5, [0x99, 0xFF, 0x22, 0x5C, 0x22]), 0, 0]);
    expect(parseC64Basic(ram)[0].text).toBe('PRINTπ"£"');
  });

  it('returns nothing when the pointers do not hold together', () => {
    const ram = new Uint8Array(0x10000);
    expect(parseC64Basic(ram)).toEqual([]);
    ram[0x2B] = 0x01; ram[0x2C] = 0x08; ram[0x2D] = 0x00; ram[0x2E] = 0x08;      // VARTAB below TXTTAB
    expect(parseC64Basic(ram)).toEqual([]);
    expect(parseC64Basic(new Uint8Array(100))).toEqual([]);
  });
});

describe('C64 BASIC floats', () => {
  it.each([
    [[0x00, 0, 0, 0, 0], '0'],
    [[0x81, 0x00, 0, 0, 0], '1'],
    [[0x82, 0x60, 0, 0, 0], '3.5'],
    [[0x82, 0xE0, 0, 0, 0], '-3.5'],
    [[0x7F, 0x00, 0, 0, 0], '.25'],
    [[0x84, 0x20, 0, 0, 0], '10'],
    [[0x7A, 0x23, 0xD7, 0x0A, 0x3D], '.01'],
    [[0x77, 0x03, 0x12, 0x6E, 0x98], '1E-03'],
    [[0xA2, 0x15, 0x02, 0xF9, 0x00], '1E+10'],
    [[0x82, 0x49, 0x0F, 0xDA, 0xA2], '3.14159265'],
  ])('%j shows as %s', (bytes, shown) => {
    expect(formatC64Float(Uint8Array.from(bytes), 0)).toBe(shown);
  });
});

describe('C64 BASIC variables', () => {
  it('reads reals, integers and strings', () => {
    const name = (a: number, b: number) => [a, b];
    const vars = [
      ...name(0x41, 0x00), 0x82, 0x60, 0, 0, 0,                   // A = 3.5
      ...name(0xC2, 0x80), 0xFF, 0xF9, 0, 0, 0,                   // B% = -7
      ...name(0x43, 0x80), 3, 0x00, 0x20, 0, 0,                   // C$ = "HEY" at $2000
    ];
    const ram = image([...line(0x0801, 10, [0x80]), 0, 0], vars);
    ram.set(text('HEY'), 0x2000);
    expect(parseC64BasicVariables(ram)).toEqual([
      { name: 'A', kind: 'number', value: '3.5' },
      { name: 'B%', kind: 'number', value: '-7' },
      { name: 'C$', kind: 'string', value: 'HEY' },
    ]);
  });

  it('reads an array header, last subscript first', () => {
    // DIM D(2,3): name, offset to the next array, 2 dims, sizes 4 then 3, 12 elements of 5 bytes.
    const size = 5 + 4 + 12 * 5;
    const arrays = [0x44, 0x00, size & 0xFF, size >> 8, 2, 0, 4, 0, 3, ...new Array(12 * 5).fill(0)];
    const ram = image([...line(0x0801, 10, [0x80]), 0, 0], [], arrays);
    expect(parseC64BasicVariables(ram)).toEqual([{ name: 'D(2,3)', kind: 'array' }]);
  });
});

const basic = romImage('basic-901226-01.rom');
const kernal = romImage('kernal-901227-03.rom');
const chargen = romImage('chargen-901225-01.rom');

function realC64(): C64Machine {
  const rom = new Uint8Array(0x5000);
  rom.set(basic!, 0);
  rom.set(kernal!, 0x2000);
  rom.set(chargen!, 0x4000);
  const m = new C64Machine('c64', null);
  m.loadROM(rom);
  m.reset();
  for (let f = 0; f < 150; f++) m.tick();
  return m;
}

function typeText(m: C64Machine, s: string): void {
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

describe.skipIf(!basic || !kernal || !chargen)('C64 BASIC parsers against the real interpreter', () => {
  it('lists a typed program and reads back what it ran', { timeout: 120_000 }, () => {
    const m = realC64();
    typeText(m, [
      '10 REM HELLO',
      '20 A=3.5:B%=-7:C$="HEY":N=1E10:S=.001:P=3.14159265358979',
      '30 DIM D(2,3),E$(4),F%(5)',
      '40 PRINT "HI";A:DATA 1,"X":GOTO 60',
      '50 FOR I=1 TO 10 STEP 2:STOP',
      '60 STOP',
      'RUN',
      '',
    ].join('\n'));
    for (let f = 0; f < 300; f++) m.tick();
    const ram = m.memory.ram;
    expect(parseC64Basic(ram).map(l => `${l.lineNumber} ${l.text}`)).toEqual([
      '10 REM HELLO',
      '20 A=3.5:B%=-7:C$="HEY":N=1E10:S=.001:P=3.14159265358979',
      '30 DIM D(2,3),E$(4),F%(5)',
      '40 PRINT "HI";A:DATA 1,"X":GOTO 60',
      '50 FOR I=1 TO 10 STEP 2:STOP',
      '60 STOP',
    ]);
    const vars = parseC64BasicVariables(ram);
    expect(vars).toEqual(expect.arrayContaining([
      { name: 'A', kind: 'number', value: '3.5' },
      { name: 'B%', kind: 'number', value: '-7' },
      { name: 'C$', kind: 'string', value: 'HEY' },
      { name: 'N', kind: 'number', value: '1E+10' },
      { name: 'S', kind: 'number', value: '1E-03' },
      { name: 'P', kind: 'number', value: '3.14159265' },
      { name: 'D(2,3)', kind: 'array' },
      { name: 'E$(4)', kind: 'array' },
      { name: 'F%(5)', kind: 'array' },
    ]));
    m.destroy();
  });

  it('shows the FOR loops in progress, innermost first, under a GOSUB', { timeout: 120_000 }, () => {
    const m = realC64();
    typeText(m, [
      '5 GOSUB 100:END',
      '100 FOR I=1 TO 10 STEP 2',
      '110 FOR J=5 TO 1 STEP -1.5:STOP',
      'RUN',
      '',
    ].join(String.fromCharCode(10)));
    for (let f = 0; f < 300; f++) m.tick();
    const loops = parseC64BasicVariables(m.memory.ram).filter(v => v.kind === 'for-next');
    expect(loops).toEqual([
      { name: 'J', kind: 'for-next', value: '5', detail: 'TO 1 STEP -1.5' },
      { name: 'I', kind: 'for-next', value: '1', detail: 'TO 10 STEP 2' },
    ]);
    m.destroy();
  });
});
