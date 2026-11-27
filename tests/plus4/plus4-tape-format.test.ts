/**
 * The C16/Plus/4 half-wave tape format (VICE's .tap version 2).
 *
 * From `KERNAL_TED_05/tapwrt.src`: the TED timer-1 levels are short 208,
 * long 420 and byte 846 ticks of two CPU cycles each, so 416 / 840 / 1692
 * cycles. A bit is four levels: a 0 is short-short-long-long and a 1
 * long-long-short-short; every byte opens with a marker-marker-long-long word
 * marker, then eight bits LSB first and an odd-parity bit.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeKernalHalves, encodeKernalTap, parseC64Tap, PLUS4_KERNAL_HALFWAVES,
  readC64TapEntries, tapFormat,
} from '@/media/tape/c64-tap.ts';
import { TapeDeck, type CswBlock } from '@/media/tape/tap.ts';
import { Plus4Machine } from '@/machines/plus4/plus4-machine.ts';

const S = PLUS4_KERNAL_HALFWAVES.short;
const L = PLUS4_KERNAL_HALFWAVES.long;
const B = PLUS4_KERNAL_HALFWAVES.marker;

const ZERO = [S, S, L, L];
const ONE = [L, L, S, S];
const WORD = [B, B, L, L];

/** KERNAL half-waves for a run of bytes, built from the encoding rules. */
function kernalHalves(bytes: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 100; i++) out.push(S);          // leader
  for (const byte of bytes) {
    out.push(...WORD);
    let ones = 0;
    for (let bit = 0; bit < 8; bit++) {
      const one = ((byte >> bit) & 1) === 1;
      if (one) ones++;
      out.push(...(one ? ONE : ZERO));
    }
    out.push(...((ones & 1) === 0 ? ONE : ZERO));       // odd parity
  }
  out.push(L, L);                                       // end of block
  return out;
}

/** Classify an encoded level relative to the nominal short one. */
function cls(v: number): 'S' | 'L' | 'B' {
  if (v < S * 1.5) return 'S';
  if (v < S * 3) return 'L';
  return 'B';
}

describe('C16/Plus/4 .tap version 2', () => {
  it('decodes bytes from the half-wave levels alone', () => {
    expect(decodeKernalHalves(kernalHalves([0x00, 0xFF, 0xA5, 0x5A])))
      .toEqual([0x00, 0xFF, 0xA5, 0x5A]);
  });

  it('reads a byte through a reference taken from its own leader', () => {
    // A 5% slower recording still classifies, because the reader measures the
    // short level instead of trusting the nominal 416 cycles.
    const slow = kernalHalves([0x89, 0x81]).map(v => Math.round(v * 1.05));
    expect(decodeKernalHalves(slow)).toEqual([0x89, 0x81]);
  });

  it('writes a program as version 2 and names its blocks', () => {
    const file = encodeKernalTap(
      [{ name: 'game', start: 0x1001, data: Uint8Array.from([0x01, 0x02, 0x03]) }],
      tapFormat(2, 0), [0x1001],
    );
    expect(file[12], 'version 2').toBe(2);
    expect(file[13], 'platform 2 = C16/Plus/4').toBe(2);
    expect(parseC64Tap(file).files).toEqual([{ type: 1, name: 'GAME', start: 0x1001, end: 0x1004 }]);
    const blocks = parseC64Tap(file).blocks as CswBlock[];
    expect(blocks.map(b => b.label)).toEqual(['"GAME"', 'Data (3 bytes)']);
  });

  it('starts every block on a high half so the reader sees the same phase', () => {
    const file = encodeKernalTap([
      { name: 'one', start: 0x1001, data: Uint8Array.of(1) },
      { name: 'two', start: 0x4001, data: Uint8Array.of(2, 3) },
    ], tapFormat(2, 0), [0x1001, 0x4001]);
    const blocks = parseC64Tap(file).blocks as CswBlock[];
    expect(blocks.map(b => b.startLevel)).toEqual([1, 1, 1, 1]);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].startLevel).toBe(1 ^ (blocks[i - 1].pulses.length & 1));
    }
  });

  it('carries the first byte as its encoding says: a word marker and four-level bits', () => {
    const file = encodeKernalTap(
      [{ name: 'x', start: 0x1001, data: Uint8Array.of(0) }], tapFormat(2, 0), [0x1001],
    );
    const entries = readC64TapEntries(file).entries;
    let at = -1;
    for (let i = 0; i + 40 < entries.length; i++) {
      if (cls(entries[i]) === 'B' && cls(entries[i + 1]) === 'B'
        && cls(entries[i + 2]) === 'L' && cls(entries[i + 3]) === 'L') { at = i; break; }
    }
    expect(at, 'the countdown byte 0x89 opens with a word marker').toBeGreaterThanOrEqual(0);
    // 0x89 = 1000 1001b: LSB-first bits 1,0,0,1,0,0,0,1 and an odd-parity 0.
    expect(Array.from(entries.subarray(at + 4, at + 40)).map(cls).join(''))
      .toBe('LLSS' + 'SSLL' + 'SSLL' + 'LLSS' + 'SSLL' + 'SSLL' + 'SSLL' + 'LLSS' + 'SSLL');
  });

  it('keeps the deck on a chosen level for a half-wave block', () => {
    const deck = new TapeDeck(1_773_447);
    deck.blocks = [
      { kind: 'csw', pulses: Uint32Array.of(1_000), startLevel: 1 },
      { kind: 'csw', pulses: Uint32Array.of(1_000), startLevel: 1 },
    ];
    deck.startPlayback();
    expect(deck.earBit, 'starts high').toBe(1);
    // The first pulse's end toggles low; the next block then seeds its own
    // level instead of carrying the toggle.
    deck.advance(1_000);
    expect(deck.earBit).toBe(1);
  });

  it('exports a KERNAL SAVE as half-waves, not paired pulses', () => {
    // A real SAVE records every level; the export must keep both halves.
    const m = new Plus4Machine('plus4', null, false);
    const rec = m.tapeRecorder;
    // The SAVE asserts the line, then writes a short square wave.
    rec.observe(1, 0);
    rec.observe(0, 160);
    rec.observe(1, 320);
    rec.observe(0, 480);
    const saved = m.services.tape.recordedBytes();
    expect(saved).not.toBeNull();
    expect(saved!.data[12], 'version 2').toBe(2);
    expect(Array.from(readC64TapEntries(saved!.data).entries)).toEqual([160, 160, 160]);
  });
});
