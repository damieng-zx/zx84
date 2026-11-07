/**
 * C64 tape formats: the raw .tap ("C64-TAPE-RAW") and the .t64 archive.
 *
 * Expectations follow the format definitions: .tap pulse bytes are units of
 * 8 cycles; a zero byte in version 0 is an overflow (taken as 256 units) and
 * in version 1 is followed by the exact length in cycles as 24 bits LE. The
 * KERNAL writes each byte as a long-medium marker then eight data bits and
 * an odd parity bit, LSB first (0 = short-medium, 1 = medium-short), and a
 * block opens with the countdown $89..$81 (a header's payload being 192
 * bytes: type, start, end, 16-character name, padding).
 */

import { describe, it, expect } from 'vitest';
import {
  decodeKernalBytes, encodeC64Tap, encodeKernalTap, halvesToPulses, isC64Tap, parseC64Tap,
  readC64TapPulses,
} from '@/media/tape/c64-tap.ts';
import { isT64, parsePrg, parseT64 } from '@/media/tape/t64.ts';
import { TAPE_REF_HZ, type CswBlock } from '@/media/tape/tap.ts';

function tapFile(version: number, body: number[]): Uint8Array {
  const out = new Uint8Array(20 + body.length);
  out.set(Array.from('C64-TAPE-RAW', c => c.charCodeAt(0)), 0);
  out[12] = version;
  out[16] = body.length & 0xFF;
  out[17] = body.length >> 8;
  out.set(body, 20);
  return out;
}

const SHORT = 0x30 * 8, MEDIUM = 0x42 * 8, LONG = 0x56 * 8;

/** KERNAL pulses for a run of bytes, built from the encoding rules. */
function kernalPulses(bytes: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 100; i++) out.push(SHORT);                // leader
  for (const b of bytes) {
    out.push(LONG, MEDIUM);
    let ones = 0;
    for (let bit = 0; bit < 8; bit++) {
      const one = ((b >> bit) & 1) === 1;
      if (one) ones++;
      out.push(...(one ? [MEDIUM, SHORT] : [SHORT, MEDIUM]));
    }
    const parity = (ones & 1) === 0;                            // odd parity
    out.push(...(parity ? [MEDIUM, SHORT] : [SHORT, MEDIUM]));
  }
  out.push(LONG, SHORT);                                        // end of data
  return out;
}

describe('C64 .tap', () => {
  it('recognises the signature', () => {
    expect(isC64Tap(tapFile(1, [0x30]))).toBe(true);
    expect(isC64Tap(new Uint8Array(20))).toBe(false);
  });

  it('reads a version-0 zero as an overflow of 256 units', () => {
    const { pulses } = readC64TapPulses(tapFile(0, [0x30, 0x00, 0x42]));
    expect(Array.from(pulses)).toEqual([0x30 * 8, 2048, 0x42 * 8]);
  });

  it('reads a version-1 zero as an exact 24-bit cycle count', () => {
    const { pulses } = readC64TapPulses(tapFile(1, [0x00, 0x40, 0x42, 0x0F, 0x30]));
    expect(Array.from(pulses)).toEqual([0x0F4240, 0x30 * 8]);
  });

  it('refuses the C16 half-wave version', () => {
    expect(() => readC64TapPulses(tapFile(2, [0x30]))).toThrow();
  });

  it('writes pulses back as a version-1 file', () => {
    const pulses = [0x30 * 8, 0x56 * 8, 100_000, 8];
    const file = encodeC64Tap(pulses);
    expect(file[12]).toBe(1);
    expect(Array.from(readC64TapPulses(file).pulses)).toEqual(pulses);
  });

  it('pairs recorded half-waves into pulses', () => {
    expect(Array.from(halvesToPulses([100, 110, 200, 210, 5]))).toEqual([210, 410]);
  });

  it('splits each pulse into two half-waves at the deck reference clock', () => {
    const tape = parseC64Tap(tapFile(1, [0x30, 0x30]));
    const block = tape.blocks[0] as CswBlock;
    const whole = Math.round(0x30 * 8 * TAPE_REF_HZ / 985_248);
    expect(block.pulses.length).toBe(4);
    expect(block.pulses[0] + block.pulses[1]).toBe(whole);
  });

  it('decodes KERNAL bytes', () => {
    expect(decodeKernalBytes(kernalPulses([0x00, 0xFF, 0xA5, 0x5A]))).toEqual([0x00, 0xFF, 0xA5, 0x5A]);
  });

  it('names a block after the KERNAL file header in it', () => {
    const payload = new Array(192).fill(0x20);
    payload[0] = 3;                                             // program at a fixed address
    payload[1] = 0x00; payload[2] = 0xC0;                       // $C000
    payload[3] = 0x34; payload[4] = 0xC1;                       // $C134
    Array.from('GAME', (c, i) => { payload[5 + i] = c.charCodeAt(0); });
    const bytes = [0x89, 0x88, 0x87, 0x86, 0x85, 0x84, 0x83, 0x82, 0x81, ...payload, 0];
    const body = kernalPulses(bytes).map(p => p / 8);
    const tape = parseC64Tap(tapFile(1, body));
    expect(tape.files).toEqual([{ type: 3, name: 'GAME', start: 0xC000, end: 0xC134 }]);
    expect((tape.blocks[0] as CswBlock).label).toBe('"GAME"');
  });
});

describe('C64 KERNAL tape writer', () => {
  const labels = (file: Uint8Array): (string | undefined)[] =>
    parseC64Tap(file).blocks.map(b => (b as CswBlock).label);

  it('writes a program as a header block then a data block', () => {
    const file = encodeKernalTap([{ name: 'game', start: 0x0801, data: Uint8Array.from([1, 2, 3, 4, 5]) }]);
    expect(isC64Tap(file)).toBe(true);
    expect(parseC64Tap(file).files).toEqual([{ type: 1, name: 'GAME', start: 0x0801, end: 0x0806 }]);
    expect(labels(file)).toEqual(['"GAME"', 'Data (5 bytes)']);
  });

  it('marks a program anywhere but $0801 as fixed in place, and cuts long names', () => {
    const file = encodeKernalTap([{ name: 'A VERY LONG PROGRAM NAME', start: 0xC000, data: new Uint8Array(300) }]);
    expect(parseC64Tap(file).files).toEqual([
      { type: 3, name: 'A VERY LONG PROG', start: 0xC000, end: 0xC12C },
    ]);
    expect(labels(file)[1]).toBe('Data (300 bytes)');
  });

  it('writes every program in turn and skips empty ones', () => {
    const file = encodeKernalTap([
      { name: 'ONE', start: 0x0801, data: Uint8Array.of(1) },
      { name: 'NONE', start: 0x0801, data: new Uint8Array(0) },
      { name: 'TWO', start: 0x0801, data: Uint8Array.of(2, 3) },
    ]);
    expect(labels(file)).toEqual(['"ONE"', 'Data (1 bytes)', '"TWO"', 'Data (2 bytes)']);
  });

  it('ends each copy with the XOR of its payload', () => {
    const data = Uint8Array.of(0x12, 0x34, 0x56);
    const { pulses } = readC64TapPulses(encodeKernalTap([{ name: 'X', start: 0x0801, data }]));
    // The data block follows the header block's gap.
    const gap = Array.from(pulses).findIndex(p => p >= 20_000);
    const bytes = decodeKernalBytes(pulses.subarray(gap + 1), 0x10000);
    expect(bytes.slice(0, 9)).toEqual([0x89, 0x88, 0x87, 0x86, 0x85, 0x84, 0x83, 0x82, 0x81]);
    expect(bytes.slice(9)).toEqual([0x12, 0x34, 0x56, 0x12 ^ 0x34 ^ 0x56]);
  });
});

describe('C64 .t64', () => {
  /** An archive of two files; the first claims an end address past the second. */
  function t64(): Uint8Array {
    const data = new Uint8Array(0x40 + 2 * 32 + 3 + 2);
    data.set(Array.from('C64 tape image file', c => c.charCodeAt(0)), 0);
    const v = new DataView(data.buffer);
    v.setUint16(0x20, 0x0101, true);
    v.setUint16(0x22, 2, true);
    v.setUint16(0x24, 2, true);
    const entry = (i: number, start: number, end: number, offset: number, name: string): void => {
      const at = 0x40 + i * 32;
      data[at] = 1; data[at + 1] = 0x82;
      v.setUint16(at + 2, start, true);
      v.setUint16(at + 4, end, true);
      v.setUint32(at + 8, offset, true);
      for (let k = 0; k < 16; k++) data[at + 0x10 + k] = k < name.length ? name.charCodeAt(k) : 0x20;
    };
    entry(0, 0x0801, 0xC000, 0x80, 'FIRST');
    entry(1, 0x1000, 0x1002, 0x83, 'SECOND');
    data.set([1, 2, 3, 4, 5], 0x80);
    return data;
  }

  it('lists the programs, sizing a bad entry by where the next one starts', () => {
    const a = t64();
    expect(isT64(a)).toBe(true);
    const progs = parseT64(a);
    expect(progs.map(p => [p.name, p.start, Array.from(p.data)])).toEqual([
      ['FIRST', 0x0801, [1, 2, 3]],
      ['SECOND', 0x1000, [4, 5]],
    ]);
  });

  it('reads a .prg load address', () => {
    const p = parsePrg(Uint8Array.from([0x01, 0x08, 0xAA, 0xBB]), 'X');
    expect(p.start).toBe(0x0801);
    expect(Array.from(p.data)).toEqual([0xAA, 0xBB]);
  });
});
