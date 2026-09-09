/**
 * The Lynx .tap container.
 *
 * It shares an extension with the ZX Spectrum's .tap and nothing else — no
 * length prefixes, no checksums, just entries whose size is implied by a type
 * letter and a 16-bit field inside them. Sizes are MAME's `camplynx_cas.cpp`;
 * the real-image arithmetic below is the check that they are right.
 */

import { describe, expect, it } from 'vitest';
import type { DataBlock } from '@/media/tape/tap.ts';
import { TAPE_REF_HZ } from '@/media/tape/tap.ts';
import {
  isLynxTap, LYNX_TAPE_HZ_128, LYNX_TAPE_HZ_48, parseLynxTap,
} from '@/media/tape/lynx-tap.ts';

const QUOTE = 0x22;

/** Build a .tap entry: an optional quoted name then a typed data entry. */
function tap(name: string | null, type: 'A' | 'B' | 'M', payload: number[]): Uint8Array {
  const out: number[] = [];
  if (name !== null) {
    out.push(QUOTE, ...[...name].map(c => c.charCodeAt(0)), QUOTE);
  }
  const len = payload.length;
  if (type === 'M') {
    // 3 + len + 7: the type letter, a 16-bit length, the payload, 7 more.
    out.push(0x4d, len & 0xff, len >> 8, ...payload, ...new Array(7).fill(0xaa));
  } else if (type === 'B') {
    out.push(0x42, len & 0xff, len >> 8, ...payload, ...new Array(3).fill(0xbb));
  } else {
    out.push(0x41, 0, 0, len & 0xff, len >> 8, ...payload, ...new Array(12).fill(0xcc));
  }
  return Uint8Array.from(out);
}

describe('Lynx .tap', () => {
  it('reads the name, the type and the load command', () => {
    const { entries } = parseLynxTap(tap('INVADERS', 'M', [1, 2, 3]));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('INVADERS');
    expect(entries[0].type).toBe('M');
    // Machine code loads with MLOAD; BASIC with LOAD.
    expect(entries[0].command).toBe('MLOAD');
    expect(parseLynxTap(tap('GAME', 'B', [1])).entries[0].command).toBe('LOAD');
  });

  it('sizes each entry the way its own type says', () => {
    // 'M' is 3 + len + 7, 'B' is 3 + len + 3, 'A' is 5 + len + 12.
    expect(parseLynxTap(tap(null, 'M', new Array(10).fill(0))).entries[0].bytes.length).toBe(20);
    expect(parseLynxTap(tap(null, 'B', new Array(10).fill(0))).entries[0].bytes.length).toBe(16);
    expect(parseLynxTap(tap(null, 'A', new Array(10).fill(0))).entries[0].bytes.length).toBe(27);
  });

  it('matches a real image byte for byte', () => {
    // "Lynx Invaders" is 12309 bytes: a 10-byte name entry ("INVADERS" in
    // quotes) and a 12299-byte 'M' entry, which is 3 + 12289 + 7.
    const payload = new Array(12289).fill(0);
    const image = tap('INVADERS', 'M', payload);
    expect(image.length).toBe(12309);
    const { entries } = parseLynxTap(image);
    expect(entries[0].bytes.length).toBe(12299);
  });

  it('reads several entries in a row, padding and stray syncs and all', () => {
    const first = tap('ONE', 'B', [1, 2]);
    const second = tap('TWO', 'M', [3, 4]);
    const image = Uint8Array.from([...first, 0, 0, 0, 0xa5, ...second, 0, 0]);
    const { entries } = parseLynxTap(image);
    expect(entries.map(e => e.name)).toEqual(['ONE', 'TWO']);
  });

  it('handles an entry with no name block', () => {
    const { entries, blocks } = parseLynxTap(tap(null, 'M', [1, 2, 3]));
    expect(entries[0].name).toBe('');
    expect(blocks).toHaveLength(1);        // no name block to play
  });

  it('puts the leader and sync byte back, which the file does not carry', () => {
    const { blocks } = parseLynxTap(tap('X', 'M', [1]));
    const name = blocks[0] as DataBlock;
    // 555 zero bytes, then A5, then the quoted name.
    expect(name.data.subarray(0, 555).every(b => b === 0)).toBe(true);
    expect(name.data[555]).toBe(0xa5);
    expect(name.data[556]).toBe(QUOTE);
    expect(name.data[557]).toBe('X'.charCodeAt(0));
  });

  it('plays as pure data — the bit width alone says which bit it is', () => {
    const block = parseLynxTap(tap('X', 'M', [1])).blocks[1] as DataBlock;
    expect(block.source).toBe('pure-data');
    expect(block.pilotCount).toBe(0);      // no pilot tone, no sync pulses
    expect(block.usedBits).toBe(8);
    // A 0 is two samples per half-cycle and a 1 is four, at 4kHz, expressed in
    // the deck's 3.5MHz reference units.
    expect(block.bit0Pulse).toBe(Math.round(2 * TAPE_REF_HZ / LYNX_TAPE_HZ_48));
    expect(block.bit1Pulse).toBe(block.bit0Pulse * 2);
  });

  it('halves the bit width on the 128K, which runs its tape twice as fast', () => {
    const at48 = parseLynxTap(tap('X', 'M', [1]), LYNX_TAPE_HZ_48).blocks[1] as DataBlock;
    const at128 = parseLynxTap(tap('X', 'M', [1]), LYNX_TAPE_HZ_128).blocks[1] as DataBlock;
    expect(at128.bit0Pulse).toBe(at48.bit0Pulse / 2);
    expect(at128.bit1Pulse).toBe(at48.bit1Pulse / 2);
  });

  it('stops rather than looping on a truncated or foreign file', () => {
    expect(parseLynxTap(Uint8Array.from([QUOTE, 0x41, 0x42])).entries).toEqual([]);
    expect(parseLynxTap(Uint8Array.from([0x99, 0x01, 0x02])).entries).toEqual([]);
    expect(parseLynxTap(new Uint8Array(0)).entries).toEqual([]);
  });

  it('tells a Lynx tape from a ZX Spectrum one wearing the same extension', () => {
    expect(isLynxTap(tap('GAME', 'M', [1, 2, 3]))).toBe(true);
    expect(isLynxTap(tap(null, 'B', [1, 2, 3]))).toBe(true);
    // A Spectrum .tap opens with a 2-byte length then a 0x00 header flag.
    expect(isLynxTap(Uint8Array.from([0x13, 0x00, 0x00, 0x00, 0x50, 0x52]))).toBe(false);
  });
});
