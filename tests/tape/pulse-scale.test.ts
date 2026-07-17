/**
 * TapeDeck pulse scaling (CDT 3.5MHz → CPC 4MHz) and faithful rawBytes playback.
 *
 * TZX/CDT pulse timings are authored at a 3.5MHz reference clock. On the CPC's
 * 4MHz Z80 every pulse must be stretched by 4/3.5 (≈1.142857). The Spectrum's
 * CPU clock *is* the 3.5MHz reference, so pulseScale defaults to 1 and playback
 * must stay byte-identical.
 *
 * Expected values are derived independently from the scale ratio, never from the
 * code under test.
 */

import { describe, it, expect } from 'vitest';
import { TapeDeck, TAPE_REF_HZ } from '@/media/tape/tap.ts';
import type { DataBlock } from '@/media/tape/tap.ts';

const CPC_SCALE = 4_000_000 / TAPE_REF_HZ; // ≈ 1.142857

describe('TapeDeck pulseScale', () => {
  it('exposes the 3.5MHz reference clock', () => {
    expect(TAPE_REF_HZ).toBe(3_500_000);
  });

  it('defaults to scale 1 — Spectrum pulse lengths are unchanged', () => {
    const deck = new TapeDeck(3_500_000);
    expect(deck.pulseScale).toBe(1);
    deck.blocks = [{ kind: 'tone', pulseLen: 2168, count: 4 }];
    deck.startPlayback();
    // First edge arrives at exactly the authored length (no rounding drift).
    expect(deck.tStatesToNextEdge()).toBe(2168);
  });

  it('scales a tone pulse by 4/3.5 for the CPC', () => {
    const deck = new TapeDeck(4_000_000);
    deck.pulseScale = CPC_SCALE;
    deck.blocks = [{ kind: 'tone', pulseLen: 1000, count: 4 }];
    deck.startPlayback();
    // round(1000 × 4/3.5) = round(1142.857) = 1143
    expect(deck.tStatesToNextEdge()).toBe(1143);

    // The EAR bit must not toggle until the scaled boundary is reached.
    deck.advance(1142);
    expect(deck.earBit).toBe(0);
    deck.advance(1);
    expect(deck.earBit).toBe(1);
  });

  it('scales a data-block pilot pulse by 4/3.5', () => {
    const deck = new TapeDeck(4_000_000);
    deck.pulseScale = CPC_SCALE;
    deck.blocks = [mkData({ pilotPulse: 2168, pilotCount: 100 })];
    deck.startPlayback();
    // round(2168 × 4/3.5) = round(2477.71) = 2478
    expect(deck.tStatesToNextEdge()).toBe(2478);
  });
});

describe('TapeDeck faithful rawBytes playback', () => {
  // A block whose first played bit differs between the verbatim rawBytes stream
  // and the Spectrum flag+payload+XOR-checksum reconstruction. pilotCount = 0
  // sends the engine straight to the DATA phase, so the first edge length is the
  // pulse for the MSB of the first played byte.
  function mkBitProbe(rawBytes?: Uint8Array): DataBlock {
    return {
      kind: 'data', flag: 0x00, data: new Uint8Array([0x00]), pause: 0,
      pilotPulse: 0, syncPulse1: 0, syncPulse2: 0,
      bit0Pulse: 100, bit1Pulse: 200, pilotCount: 0, usedBits: 8,
      source: 'turbo', rawBytes,
    };
  }

  it('plays rawBytes verbatim instead of rebuilding the frame', () => {
    const raw = new TapeDeck(3_500_000);
    raw.blocks = [mkBitProbe(new Uint8Array([0x80, 0x00]))]; // MSB of 0x80 = 1
    raw.startPlayback();
    expect(raw.tStatesToNextEdge()).toBe(200); // bit1 pulse → rawBytes was used

    const built = new TapeDeck(3_500_000);
    built.blocks = [mkBitProbe()];              // flag 0x00 → MSB = 0
    built.startPlayback();
    expect(built.tStatesToNextEdge()).toBe(100); // bit0 pulse → reconstructed frame
  });

  it('scales rawBytes pulses on the CPC too', () => {
    const deck = new TapeDeck(4_000_000);
    deck.pulseScale = CPC_SCALE;
    deck.blocks = [mkBitProbe(new Uint8Array([0x80, 0x00]))];
    deck.startPlayback();
    // round(200 × 4/3.5) = round(228.57) = 229
    expect(deck.tStatesToNextEdge()).toBe(229);
  });
});

function mkData(over: Partial<DataBlock>): DataBlock {
  return {
    kind: 'data', flag: 0xFF, data: new Uint8Array([0x55]), pause: 0,
    pilotPulse: 2168, syncPulse1: 667, syncPulse2: 735,
    bit0Pulse: 855, bit1Pulse: 1710, pilotCount: 3223, usedBits: 8,
    source: 'turbo', ...over,
  };
}
