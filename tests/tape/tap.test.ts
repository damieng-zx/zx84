import { describe, it, expect } from 'vitest';
import { TapeDeck } from '@/tape/tap.ts';
import type { DataBlock } from '@/tape/tap.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

/** XOR-checksum of a byte sequence (starting from 0). */
function xorSum(bytes: number[] | Uint8Array): number {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c ^= (bytes as Uint8Array)[i] ?? (bytes as number[])[i];
  return c & 0xFF;
}

/**
 * Build a TAP block from flag + payload, computing the checksum.
 * Returns the on-tape bytes: 2-byte LE length, flag, payload, checksum.
 */
function buildBlock(flag: number, payload: Uint8Array | number[]): Uint8Array {
  const payloadArr = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const blockLen = 1 + payloadArr.length + 1; // flag + payload + checksum
  const out = new Uint8Array(2 + blockLen);
  out[0] = blockLen & 0xFF;
  out[1] = (blockLen >> 8) & 0xFF;
  out[2] = flag;
  out.set(payloadArr, 3);
  let cs = flag;
  for (let i = 0; i < payloadArr.length; i++) cs ^= payloadArr[i];
  out[2 + blockLen - 1] = cs & 0xFF;
  return out;
}

/** Build a 17-byte header payload per ZX Spectrum convention. */
function buildHeaderPayload(
  type: number,           // 0=Program, 1=Number array, 2=Char array, 3=Code
  filename: string,       // up to 10 chars, blank-padded
  dataLength: number,
  param1: number,
  param2: number
): Uint8Array {
  const p = new Uint8Array(17);
  p[0] = type;
  const name = filename.padEnd(10, ' ');
  for (let i = 0; i < 10; i++) p[1 + i] = name.charCodeAt(i) & 0xFF;
  p[11] = dataLength & 0xFF;
  p[12] = (dataLength >> 8) & 0xFF;
  p[13] = param1 & 0xFF;
  p[14] = (param1 >> 8) & 0xFF;
  p[15] = param2 & 0xFF;
  p[16] = (param2 >> 8) & 0xFF;
  return p;
}

/** Concatenate multiple on-tape blocks into a single TAP image. */
function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ── Format parsing — happy paths ───────────────────────────────────────────

describe('TAP — basic parsing', () => {
  it('returns an empty block list for an empty file', () => {
    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(new Uint8Array(0));
    expect(blocks).toEqual([]);
  });

  it('parses a single header block (flag=0x00, 17-byte payload)', () => {
    const payload = buildHeaderPayload(0, 'PROGRAM', 100, 10, 0x8000);
    const tap = buildBlock(0x00, payload);
    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(tap);

    expect(blocks.length).toBe(1);
    const b = blocks[0] as DataBlock;
    expect(b.kind).toBe('data');
    expect(b.flag).toBe(0x00);
    expect(b.data.length).toBe(17);
    expect(b.data[0]).toBe(0); // type = Program
    expect(String.fromCharCode(...b.data.subarray(1, 8))).toBe('PROGRAM');
    expect(b.data[11] | (b.data[12] << 8)).toBe(100);
    expect(b.data[13] | (b.data[14] << 8)).toBe(10);
    expect(b.data[15] | (b.data[16] << 8)).toBe(0x8000);
    expect(b.source).toBe('tap');
  });

  it('parses a single data block (flag=0xFF, arbitrary payload)', () => {
    const payload = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
    const tap = buildBlock(0xFF, payload);
    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(tap);

    expect(blocks.length).toBe(1);
    const b = blocks[0] as DataBlock;
    expect(b.flag).toBe(0xFF);
    expect(Array.from(b.data)).toEqual([0x11, 0x22, 0x33, 0x44, 0x55]);
  });

  it('parses a canonical header+data pair', () => {
    const hdr = buildBlock(0x00, buildHeaderPayload(3, 'CODE', 8, 0x8000, 0x8000));
    const data = buildBlock(0xFF, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    const tap = concat(hdr, data);
    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(tap);

    expect(blocks.length).toBe(2);
    expect((blocks[0] as DataBlock).flag).toBe(0x00);
    expect((blocks[1] as DataBlock).flag).toBe(0xFF);
    expect((blocks[1] as DataBlock).data.length).toBe(8);
  });

  it('parses many consecutive blocks', () => {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 10; i++) {
      parts.push(buildBlock(0xFF, [i, i + 1, i + 2]));
    }
    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(concat(...parts));
    expect(blocks.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect((blocks[i] as DataBlock).data[0]).toBe(i);
    }
  });
});

// ── Length-field handling (endianness, edge cases) ─────────────────────────

describe('TAP — block length field', () => {
  it('is little-endian (multi-byte payload sizes parse correctly)', () => {
    // 1000-byte payload → blockLen = 1002 = 0x03EA, LE bytes 0xEA, 0x03.
    const payload = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) payload[i] = (i * 7) & 0xFF;
    const tap = buildBlock(0xFF, payload);

    expect(tap[0]).toBe(0xEA);
    expect(tap[1]).toBe(0x03);

    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(tap);
    expect(blocks.length).toBe(1);
    expect((blocks[0] as DataBlock).data.length).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      expect((blocks[0] as DataBlock).data[i]).toBe((i * 7) & 0xFF);
    }
  });

  it('accepts the minimum valid blockLen of 2 (flag + checksum, empty payload)', () => {
    // 1-byte flag + 0-byte payload + 1-byte checksum = blockLen 2.
    const tap = new Uint8Array([0x02, 0x00, 0x42, 0x42]); // checksum of flag=0x42 alone is 0x42
    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(tap);
    expect(blocks.length).toBe(1);
    expect((blocks[0] as DataBlock).flag).toBe(0x42);
    expect((blocks[0] as DataBlock).data.length).toBe(0);
  });

  it('rejects blockLen=0 (no flag, no checksum)', () => {
    const tap = new Uint8Array([0x00, 0x00]);
    const deck = new TapeDeck(3_500_000);
    expect(deck.parseTAP(tap)).toEqual([]);
  });

  it('rejects blockLen=1 (cannot have flag and checksum in 1 byte)', () => {
    const tap = new Uint8Array([0x01, 0x00, 0x55]);
    const deck = new TapeDeck(3_500_000);
    expect(deck.parseTAP(tap)).toEqual([]);
  });

  it('stops at a truncated length field (1 byte remaining)', () => {
    const valid = buildBlock(0xFF, [0xAA, 0xBB]);
    const tap = concat(valid, new Uint8Array([0x10])); // one stray byte
    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(tap);
    expect(blocks.length).toBe(1);
    expect((blocks[0] as DataBlock).data.length).toBe(2);
  });

  it('stops at a truncated payload (length declares more bytes than the file has)', () => {
    const valid = buildBlock(0xFF, [0xAA, 0xBB]);
    // Declared length 100 but only 5 bytes follow.
    const truncated = new Uint8Array([0x64, 0x00, 0xFF, 0x01, 0x02, 0x03, 0x04]);
    const tap = concat(valid, truncated);
    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(tap);
    // Only the first (valid) block survives.
    expect(blocks.length).toBe(1);
    expect((blocks[0] as DataBlock).data.length).toBe(2);
  });
});

// ── Pilot count selection (the bug we just fixed) ──────────────────────────

describe('TAP — pilot count selection by flag bit 7', () => {
  // Per ZX Spectrum ROM SAVE-BYTES: flag < 0x80 → long header pilot (8063),
  // flag >= 0x80 → short data pilot (3223). Only the high bit matters.

  it.each([
    [0x00, 8063, 'standard header'],
    [0x01, 8063, 'unusual low flag (still header pilot)'],
    [0x55, 8063, 'mid-range low flag'],
    [0x7F, 8063, 'highest header-pilot flag'],
    [0x80, 3223, 'lowest data-pilot flag'],
    [0xAA, 3223, 'mid-range high flag'],
    [0xFF, 3223, 'standard data'],
  ])('flag 0x%s → pilotCount=%i (%s)', (flag, expectedPilot) => {
    const tap = buildBlock(flag, new Uint8Array(4));
    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(tap);
    expect((blocks[0] as DataBlock).pilotCount).toBe(expectedPilot);
  });
});

// ── Default block parameters ───────────────────────────────────────────────

describe('TAP — default DataBlock parameters', () => {
  it('uses standard Spectrum pulse timings and a 1000ms pause', () => {
    const tap = buildBlock(0xFF, new Uint8Array(8));
    const deck = new TapeDeck(3_500_000);
    const b = deck.parseTAP(tap)[0] as DataBlock;

    expect(b.pause).toBe(1000);
    expect(b.pilotPulse).toBe(2168);
    expect(b.syncPulse1).toBe(667);
    expect(b.syncPulse2).toBe(735);
    expect(b.bit0Pulse).toBe(855);
    expect(b.bit1Pulse).toBe(1710);
    expect(b.usedBits).toBe(8);
    expect(b.source).toBe('tap');
  });
});

// ── Checksum behaviour ─────────────────────────────────────────────────────

describe('TAP — checksum handling', () => {
  it('does not validate the on-tape checksum (corrupt checksum still parses)', () => {
    // Build a valid block, then deliberately corrupt its checksum byte.
    const tap = buildBlock(0xFF, [0x11, 0x22, 0x33]);
    tap[tap.length - 1] ^= 0xFF; // flip every bit of the checksum
    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(tap);
    expect(blocks.length).toBe(1);
    expect(Array.from((blocks[0] as DataBlock).data)).toEqual([0x11, 0x22, 0x33]);
  });

  it('checksum of a known payload matches XOR of flag + data bytes', () => {
    // Flag=0xFF, payload=[0x11,0x22,0x33] → checksum = 0xFF ^ 0x11 ^ 0x22 ^ 0x33
    const flag = 0xFF;
    const payload = [0x11, 0x22, 0x33];
    const tap = buildBlock(flag, payload);
    expect(tap[tap.length - 1]).toBe(xorSum([flag, ...payload]));
  });

  it('checksum of a block with no payload equals the flag byte itself', () => {
    const tap = buildBlock(0x5A, []);
    expect(tap[tap.length - 1]).toBe(0x5A);
  });
});

// ── Deck state after load() ────────────────────────────────────────────────

describe('TAP — deck state after load()', () => {
  it('stores parsed blocks and resets position to 0', () => {
    const tap = concat(
      buildBlock(0x00, buildHeaderPayload(3, 'X', 4, 0, 0)),
      buildBlock(0xFF, [1, 2, 3, 4]),
    );
    const deck = new TapeDeck(3_500_000);
    deck.load(tap);
    expect(deck.blocks.length).toBe(2);
    expect(deck.position).toBe(0);
    expect(deck.paused).toBe(false);
    expect(deck.playing).toBe(false);
    expect(deck.loaded).toBe(true);
    expect(deck.finished).toBe(false);
  });

  it('reports loaded=false for an empty TAP', () => {
    const deck = new TapeDeck(3_500_000);
    deck.load(new Uint8Array(0));
    expect(deck.loaded).toBe(false);
    expect(deck.finished).toBe(true);
  });

  it('rewind() returns position to 0 after consuming blocks', () => {
    const tap = concat(
      buildBlock(0xFF, [1]),
      buildBlock(0xFF, [2]),
    );
    const deck = new TapeDeck(3_500_000);
    deck.load(tap);
    deck.nextDataBlock();
    expect(deck.position).toBe(1);
    deck.rewind();
    expect(deck.position).toBe(0);
  });
});

// ── nextDataBlock / hasRomBlock ────────────────────────────────────────────

describe('TAP — nextDataBlock() iteration', () => {
  it('returns each block in order then null', () => {
    const tap = concat(
      buildBlock(0x00, buildHeaderPayload(0, 'A', 10, 0, 0)),
      buildBlock(0xFF, [1, 2, 3]),
      buildBlock(0xFF, [4, 5, 6]),
    );
    const deck = new TapeDeck(3_500_000);
    deck.load(tap);

    const b1 = deck.nextDataBlock();
    expect(b1?.flag).toBe(0x00);
    const b2 = deck.nextDataBlock();
    expect(b2?.flag).toBe(0xFF);
    expect(Array.from(b2!.data)).toEqual([1, 2, 3]);
    const b3 = deck.nextDataBlock();
    expect(Array.from(b3!.data)).toEqual([4, 5, 6]);
    expect(deck.nextDataBlock()).toBeNull();
    expect(deck.finished).toBe(true);
  });

  it('hasRomBlock() agrees with nextDataBlock() availability', () => {
    const tap = buildBlock(0xFF, [1, 2, 3]);
    const deck = new TapeDeck(3_500_000);
    deck.load(tap);
    expect(deck.hasRomBlock()).toBe(true);
    deck.nextDataBlock();
    expect(deck.hasRomBlock()).toBe(false);
  });
});

// ── Raw playback data reconstruction ───────────────────────────────────────

describe('TAP — raw on-tape data reconstruction', () => {
  // The deck reconstructs flag+payload+XOR-checksum for pulse-level
  // playback. We can't observe rawData directly, but a round-trip through
  // parseTAP and then back to a buildBlock-style serialisation must match.
  function serialiseFromBlock(b: DataBlock): Uint8Array {
    return buildBlock(b.flag, b.data);
  }

  it('round-trips flag + payload + checksum byte-identically', () => {
    const original = buildBlock(0xAB, [0x10, 0x20, 0x30, 0x40, 0x50]);
    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(original);
    const reserialised = serialiseFromBlock(blocks[0] as DataBlock);
    expect(reserialised.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(reserialised[i]).toBe(original[i]);
    }
  });

  it('parser preserves the on-tape flag verbatim (even invalid checksum)', () => {
    // Corrupt checksum should not affect the parsed flag/payload.
    const tap = buildBlock(0x42, [0xDE, 0xAD, 0xBE, 0xEF]);
    tap[tap.length - 1] = 0x00; // wipe checksum
    const deck = new TapeDeck(3_500_000);
    const b = deck.parseTAP(tap)[0] as DataBlock;
    expect(b.flag).toBe(0x42);
    expect(Array.from(b.data)).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
  });
});

// ── parseTAP statelessness ──────────────────────────────────────────────────

describe('TAP — parseTAP does not modify deck state', () => {
  it('parseTAP returns blocks without changing deck.blocks, position, or flags', () => {
    const tap = buildBlock(0xFF, [1, 2, 3]);
    const deck = new TapeDeck(3_500_000);
    deck.load(tap);
    expect(deck.blocks.length).toBe(1);
    deck.position = 1;

    const blocks = deck.parseTAP(buildBlock(0x00, [4, 5]));
    expect(blocks.length).toBe(1);

    // deck state should be untouched by the pure parse call.
    expect(deck.blocks.length).toBe(1);
    expect(deck.position).toBe(1);
    expect((deck.blocks[0] as DataBlock).flag).toBe(0xFF);
  });
});
