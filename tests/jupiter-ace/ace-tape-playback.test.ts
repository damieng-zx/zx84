/**
 * What the deck actually puts on the wire for an Ace .tap, measured edge by
 * edge and checked against the ROM's own SAVE routine (0x1820-0x189A) — the
 * definitive statement of the format. Every expected width below is the
 * instruction timing of that routine, worked out by hand and hard-coded:
 *
 *   pilot half-cycle  LD B,97 (7) + DJNZ×151 (150×13+8) + OUT (11)
 *                     + XOR (7) + INC L (4) + JR NZ (12) + JR NZ (12) = 2011T
 *   sync 1            pilot-loop tail (29) + LD B,2B (7)
 *                     + DJNZ×43 (42×13+8) + OUT (11)                  = 601T
 *   sync 2            LD L,C (4) + LD BC,3B08 (10) + DJNZ×59 (58×13+8)
 *                     + LD A,C (4) + OUT (11)                         = 791T
 *   bit 0 / bit 1     two equal half-cycles of 795T / 1585T
 *   pilot edges       8192 per header block, 1024 per data block
 *
 * Two edges per bit is what the loader demands: its per-bit measurement at
 * 0x18FC calls 0x1911, which times one edge and falls through into 0x1915 to
 * time a second, so a bit is a full cycle and not a lone pulse.
 */

import { describe, it, expect } from 'vitest';
import { parseAceTap, ACE_TAPE_HEADER_CHUNK } from '@/machines/jupiter-ace/ace-tape.ts';
import { TapeDeck } from '@/media/tape/tap.ts';
import { ACE_CPU_CLOCK } from '@/machines/jupiter-ace/constants.ts';

/** Ace hardware widths, in Ace T-states (see the derivation above). */
const PILOT_T = 2011;
const SYNC1_T = 601;
const SYNC2_T = 791;
const BIT0_T = 795;
const BIT1_T = 1585;
const PILOT_EDGES_HEADER = 8192;
const PILOT_EDGES_DATA = 1024;

function aceHeaderBytes(name: string, length: number, start: number, type = 0): Uint8Array {
  const h = new Uint8Array(ACE_TAPE_HEADER_CHUNK).fill(0x20);
  h[0] = type;
  for (let i = 0; i < name.length; i++) h[1 + i] = name.charCodeAt(i);
  h[11] = length & 0xFF;
  h[12] = (length >> 8) & 0xFF;
  h[13] = start & 0xFF;
  h[14] = (start >> 8) & 0xFF;
  let xor = 0;
  for (let i = 0; i < 25; i++) xor ^= h[i];
  h[25] = xor;
  return h;
}

function deckAt(tap: Uint8Array, position = 0): TapeDeck {
  const deck = new TapeDeck(ACE_CPU_CLOCK);
  deck.pulseScale = ACE_CPU_CLOCK / 3_500_000;
  deck.blocks = parseAceTap(tap);
  deck.position = position;
  deck.startPlayback();
  deck.paused = false;
  return deck;
}

/** Every EAR transition of the current block, as widths in Ace T-states.
 *  Stops when the block ends (the trailing pause schedules no edges). */
function playEdges(deck: TapeDeck, max = 40000): number[] {
  const widths: number[] = [];
  for (let i = 0; i < max; i++) {
    const next = deck.tStatesToNextEdge();
    if (next === null) break;
    deck.advance(next);
    widths.push(next);
  }
  return widths;
}

const HEADER = aceHeaderBytes('HELLO', 100, 15441);
const DATA_CHUNK = Uint8Array.from([1, 2, 3, 0x55]);
const TAP = new Uint8Array([
  ACE_TAPE_HEADER_CHUNK, 0, ...HEADER,
  DATA_CHUNK.length, 0, ...DATA_CHUNK,
]);

describe('Ace deck output vs the ROM SAVE routine', () => {
  it('plays a 8192-edge 2011T pilot, then 601T and 791T sync', () => {
    const widths = playEdges(deckAt(TAP));
    const pilot = widths.slice(0, PILOT_EDGES_HEADER);
    expect([...new Set(pilot)]).toEqual([PILOT_T]);
    // The 8193rd edge is sync, which pins the pilot edge count exactly.
    expect(widths[PILOT_EDGES_HEADER]).toBe(SYNC1_T);
    expect(widths[PILOT_EDGES_HEADER + 1]).toBe(SYNC2_T);
  });

  it('encodes each bit as two equal half-cycles of 795T or 1585T', () => {
    const widths = playEdges(deckAt(TAP)).slice(PILOT_EDGES_HEADER + 2);
    // flag + 26 chunk bytes, 8 bits each, 2 edges per bit.
    expect(widths.length).toBe((1 + ACE_TAPE_HEADER_CHUNK) * 8 * 2);
    for (let i = 0; i < widths.length; i += 2) {
      expect(widths[i]).toBe(widths[i + 1]);
      expect([BIT0_T, BIT1_T]).toContain(widths[i]);
    }
  });

  it('puts the synthesized flag and the chunk bytes on the wire, MSB first', () => {
    const widths = playEdges(deckAt(TAP)).slice(PILOT_EDGES_HEADER + 2);
    const bytes: number[] = [];
    for (let i = 0; i < widths.length; i += 16) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        byte = (byte << 1) | (widths[i + bit * 2] === BIT1_T ? 1 : 0);
      }
      bytes.push(byte);
    }
    expect(bytes[0]).toBe(0x00);                       // synthesized header flag
    expect(bytes.slice(1)).toEqual(Array.from(HEADER));
    // The ROM's checksum is an XOR over the chunk (the flag is seeded into H
    // separately), so the recovered chunk must self-cancel.
    expect(bytes.slice(1).reduce((a, b) => a ^ b, 0)).toBe(0);
  });

  it('gives a data block the short 1024-edge pilot', () => {
    const widths = playEdges(deckAt(TAP, 1));
    const pilot = widths.slice(0, PILOT_EDGES_DATA);
    expect([...new Set(pilot)]).toEqual([PILOT_T]);
    expect(widths[PILOT_EDGES_DATA]).toBe(SYNC1_T);
    expect(widths[PILOT_EDGES_DATA + 1]).toBe(SYNC2_T);
    // Data blocks carry the 0xFF flag ahead of the chunk.
    const data = widths.slice(PILOT_EDGES_DATA + 2);
    expect(data.length).toBe((1 + DATA_CHUNK.length) * 8 * 2);
    expect(data.slice(0, 16)).toEqual(Array(16).fill(BIT1_T));
  });
});
