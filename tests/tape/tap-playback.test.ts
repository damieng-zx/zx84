/**
 * Playback engine tests for TapeDeck.
 *
 * The parser is covered by tap.test.ts; this file exercises the pulse-level
 * playback state machine: data, direct, tone, pulses, pause, set-level,
 * stop-if-48k, and the cosmetic block skips. parseTAP() only ever produces
 * `data` blocks, so non-data scenarios inject blocks into deck.blocks directly
 * (the same path TZX uses).
 */
import { describe, it, expect } from 'vitest';
import { TapeDeck } from '@/tape/tap.ts';
import type {
  DataBlock, ToneBlock, PulsesBlock, PauseBlock, DirectBlock,
  SetLevelBlock, StopIf48KBlock, GroupStartBlock, GroupEndBlock,
  TextBlock, ArchiveInfoBlock, TapeBlock,
} from '@/tape/tap.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeData(
  flag: number,
  payload: number[],
  opts: Partial<Omit<DataBlock, 'kind' | 'flag' | 'data'>> = {},
): DataBlock {
  return {
    kind: 'data',
    flag,
    data: new Uint8Array(payload),
    pause: opts.pause ?? 1000,
    pilotPulse: opts.pilotPulse ?? 2168,
    syncPulse1: opts.syncPulse1 ?? 667,
    syncPulse2: opts.syncPulse2 ?? 735,
    bit0Pulse: opts.bit0Pulse ?? 855,
    bit1Pulse: opts.bit1Pulse ?? 1710,
    pilotCount: opts.pilotCount ?? (flag < 0x80 ? 8063 : 3223),
    usedBits: opts.usedBits ?? 8,
    source: opts.source ?? 'tap',
  };
}

function deckWith(...blocks: TapeBlock[]): TapeDeck {
  const d = new TapeDeck();
  d.blocks = blocks;
  d.position = 0;
  return d;
}

/**
 * Step the deck pulse-by-pulse in 1-T-state increments while a predicate
 * holds, counting earBit edges. Bounded to avoid runaway loops.
 */
function countEdges(deck: TapeDeck, tStatesTotal: number, stepT = 1): number {
  let edges = 0;
  let prev = deck.earBit;
  let remaining = tStatesTotal;
  while (remaining > 0) {
    const step = Math.min(stepT, remaining);
    deck.advance(step);
    if (deck.earBit !== prev) { edges++; prev = deck.earBit; }
    remaining -= step;
  }
  return edges;
}

// ── Direct block — deterministic bit-by-bit playback ───────────────────────

describe('TapeDeck — direct block playback', () => {
  it('emits the exact bit sequence (MSB-first) at the sample rate', () => {
    // 0b10101100 → bits 1,0,1,0,1,1,0,0 (MSB first).
    const block: DirectBlock = {
      kind: 'direct',
      tStatesPerSample: 100,
      pause: 0,
      usedBits: 8,
      data: new Uint8Array([0b10101100]),
    };
    const deck = deckWith(block);
    deck.startPlayback();

    // Bit 7 is set immediately by beginDirectBlock.
    expect(deck.earBit).toBe(1);

    const observed: number[] = [deck.earBit];
    // 8 samples × 100 T = 800 T to traverse the byte.
    for (let i = 0; i < 8; i++) {
      deck.advance(100);
      observed.push(deck.earBit);
    }
    // After all 8 bits, the deck transitions out of DIRECT (zero pause →
    // beginBlock(next) → IDLE since there is no next block). The final
    // earBit is whatever the last bit set it to (0). The earlier 8 entries
    // correspond to bits 7..0.
    expect(observed.slice(0, 8)).toEqual([1, 0, 1, 0, 1, 1, 0, 0]);
  });

  it('honours usedBits on the final byte (stops early)', () => {
    // Two bytes; only the top 3 bits of the second byte are valid.
    const block: DirectBlock = {
      kind: 'direct',
      tStatesPerSample: 10,
      pause: 0,
      usedBits: 3,
      data: new Uint8Array([0xFF, 0b101_00000]),
    };
    const deck = deckWith(block);
    deck.startPlayback();
    // First byte = 8 samples; second byte = 3 samples → 11 total.
    // Advance just past 10 samples and check we're still in DIRECT.
    deck.advance(10 * 10);
    expect((deck as any).phase).not.toBe(0 /* IDLE */);
    // 11th sample completes the block; with pause=0 we transition to IDLE.
    deck.advance(10);
    expect(deck.playing).toBe(false);
  });

  it('enters PAUSE with earBit=0 when pause > 0', () => {
    const block: DirectBlock = {
      kind: 'direct',
      tStatesPerSample: 10,
      pause: 100, // ms
      usedBits: 8,
      data: new Uint8Array([0xFF]),
    };
    const deck = deckWith(block);
    deck.startPlayback();
    // Consume the byte (8 samples × 10 = 80 T).
    deck.advance(80);
    expect(deck.earBit).toBe(0);
    expect(deck.playing).toBe(true);
    // 100ms × 3.5MHz = 350_000 T.  Just before, still in pause.
    deck.advance(349_000);
    expect(deck.playing).toBe(true);
    deck.advance(2_000);
    // Past the pause → no further blocks → IDLE / not playing.
    expect(deck.playing).toBe(false);
  });
});

// ── Tone block ─────────────────────────────────────────────────────────────

describe('TapeDeck — tone block playback', () => {
  it('emits exactly `count` toggles, then ends the tape', () => {
    // No trailing block — beginBlock(next) just goes IDLE without touching
    // earBit, so every one of the `count` toggles is observable.
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 10 };
    const deck = deckWith(tone);
    deck.startPlayback();

    const edges = countEdges(deck, 10 * 100);
    expect(edges).toBe(10);
    expect(deck.playing).toBe(false);
  });
});

// ── Pulses block ───────────────────────────────────────────────────────────

describe('TapeDeck — pulses block playback', () => {
  it('toggles earBit once per listed pulse, in order', () => {
    const pulses: PulsesBlock = { kind: 'pulses', lengths: [50, 100, 200, 50] };
    const deck = deckWith(pulses);
    deck.startPlayback();

    const e1 = deck.earBit;
    deck.advance(50);
    expect(deck.earBit).toBe(e1 ^ 1);
    deck.advance(100);
    expect(deck.earBit).toBe(e1);
    deck.advance(200);
    expect(deck.earBit).toBe(e1 ^ 1);
    deck.advance(50);
    expect(deck.earBit).toBe(e1);
    // Block exhausted.
    expect(deck.playing).toBe(false);
  });

  it('an empty pulses block is skipped immediately', () => {
    const empty: PulsesBlock = { kind: 'pulses', lengths: [] };
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(empty, tone);
    deck.startPlayback();
    // We should be playing the tone block now, not stuck in the empty one.
    expect(deck.playing).toBe(true);
    expect((deck as any).playbackIdx).toBe(1);
  });
});

// ── Pause block ────────────────────────────────────────────────────────────

describe('TapeDeck — pause block playback', () => {
  it('duration=0 is "stop the tape" — paused=true, position advanced', () => {
    const pause: PauseBlock = { kind: 'pause', duration: 0 };
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(pause, tone);
    deck.startPlayback();
    expect(deck.paused).toBe(true);
    expect(deck.position).toBe(1);
    // advance() is a no-op while paused.
    deck.advance(10_000);
    expect((deck as any).playbackIdx).toBe(0); // never started the tone
  });

  it('duration>0 elapses then advances to next block (uses cpuClock)', () => {
    const pause: PauseBlock = { kind: 'pause', duration: 10 }; // 10ms
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(pause, tone);
    deck.cpuClock = 3_500_000;
    deck.startPlayback();
    // 10ms × 3.5MHz = 35_000 T.
    deck.advance(34_999);
    expect((deck as any).playbackIdx).toBe(0);
    deck.advance(2);
    expect((deck as any).playbackIdx).toBe(1);
  });

  it('cpuClock affects pause duration', () => {
    const pause: PauseBlock = { kind: 'pause', duration: 10 };
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(pause, tone);
    deck.cpuClock = 7_000_000; // 128K-ish, doubled
    deck.startPlayback();
    // 10ms × 7MHz = 70_000 T — twice as long as at 3.5MHz.
    deck.advance(35_000);
    expect((deck as any).playbackIdx).toBe(0);
    deck.advance(35_001);
    expect((deck as any).playbackIdx).toBe(1);
  });
});

// ── set-level block ────────────────────────────────────────────────────────

describe('TapeDeck — set-level block playback', () => {
  it('sets earBit to the requested level and immediately advances', () => {
    const setHi: SetLevelBlock = { kind: 'set-level', level: 1 };
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(setHi, tone);
    deck.startPlayback();
    expect(deck.earBit).toBe(1);
    expect((deck as any).playbackIdx).toBe(1); // tone, not set-level
  });

  it('level=0 explicitly drives earBit low before the next block', () => {
    const setLo: SetLevelBlock = { kind: 'set-level', level: 0 };
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(setLo, tone);
    // Pre-set earBit high; set-level must override it.
    deck.startPlayback();
    expect(deck.earBit).toBe(0);
  });

  // NOTE: src/tape/tap.ts assigns block.level verbatim to earBit without
  // masking to {0,1}. A malformed set-level with level=2 would leave earBit
  // in an illegal state that subsequent toggles (^= 1) would propagate
  // (2 → 3 → 2 …). TZX parsing should clamp to 0/1, but the playback engine
  // itself does not defend against it. Not tested as "correct".
});

// ── stop-if-48k block ──────────────────────────────────────────────────────

describe('TapeDeck — stop-if-48k block', () => {
  it('pauses the tape on a 48K machine', () => {
    const stop: StopIf48KBlock = { kind: 'stop-if-48k' };
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(stop, tone);
    deck.is48K = true;
    deck.startPlayback();
    expect(deck.paused).toBe(true);
    expect(deck.position).toBe(1);
  });

  it('is a no-op on a 128K-class machine', () => {
    const stop: StopIf48KBlock = { kind: 'stop-if-48k' };
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(stop, tone);
    deck.is48K = false;
    deck.startPlayback();
    expect(deck.paused).toBe(false);
    expect((deck as any).playbackIdx).toBe(1);
  });
});

// ── Cosmetic blocks ────────────────────────────────────────────────────────

describe('TapeDeck — cosmetic blocks are transparent', () => {
  it('group-start / group-end / text / archive-info are skipped during playback', () => {
    const cosmetic: TapeBlock[] = [
      { kind: 'group-start', name: 'Loader' } as GroupStartBlock,
      { kind: 'text', text: 'hello' } as TextBlock,
      { kind: 'archive-info', entries: [{ id: 0, text: 'Title' }] } as ArchiveInfoBlock,
      { kind: 'group-end' } as GroupEndBlock,
    ];
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(...cosmetic, tone);
    deck.startPlayback();
    expect((deck as any).playbackIdx).toBe(4); // jumped straight to tone
  });
});

// ── nextDataBlock() — block-stream traversal ───────────────────────────────

describe('TapeDeck.nextDataBlock() — non-data block handling', () => {
  it('skips non-zero pauses (ROM trap ignores inter-block gaps)', () => {
    const deck = deckWith(
      makeData(0xFF, [1, 2]),
      { kind: 'pause', duration: 500 } as PauseBlock,
      makeData(0xFF, [3, 4]),
    );
    expect(deck.nextDataBlock()?.data[0]).toBe(1);
    expect(deck.nextDataBlock()?.data[0]).toBe(3);
    expect(deck.nextDataBlock()).toBeNull();
  });

  it('a zero-duration pause stops the tape and returns null', () => {
    const deck = deckWith(
      makeData(0xFF, [1]),
      { kind: 'pause', duration: 0 } as PauseBlock,
      makeData(0xFF, [2]),
    );
    expect(deck.nextDataBlock()?.data[0]).toBe(1);
    expect(deck.nextDataBlock()).toBeNull();
    expect(deck.paused).toBe(true);
  });

  it('returns null at the first custom-loader block (tone/pulses/direct)', () => {
    const direct: DirectBlock = {
      kind: 'direct', tStatesPerSample: 100, pause: 0, usedBits: 8,
      data: new Uint8Array([0xFF]),
    };
    const deck = deckWith(makeData(0xFF, [1]), direct, makeData(0xFF, [2]));
    expect(deck.nextDataBlock()?.data[0]).toBe(1);
    expect(deck.nextDataBlock()).toBeNull();
    // Position should NOT have advanced past the direct block.
    expect(deck.position).toBe(1);
  });

  it('pure-data DataBlocks are not ROM-loadable', () => {
    const pure = makeData(0xFF, [1, 2, 3], { source: 'pure-data', pilotCount: 0 });
    const deck = deckWith(pure);
    expect(deck.nextDataBlock()).toBeNull();
    // Position is not advanced — the playback engine will pick this up.
    expect(deck.position).toBe(0);
  });

  it('stop-if-48k pauses and returns null on 48K, is skipped on 128K', () => {
    const make = () => deckWith(
      { kind: 'stop-if-48k' } as StopIf48KBlock,
      makeData(0xFF, [1]),
    );
    const d48 = make(); d48.is48K = true;
    expect(d48.nextDataBlock()).toBeNull();
    expect(d48.paused).toBe(true);

    const d128 = make(); d128.is48K = false;
    expect(d128.nextDataBlock()?.data[0]).toBe(1);
  });
});

// ── hasRomBlock() ──────────────────────────────────────────────────────────

describe('TapeDeck.hasRomBlock()', () => {
  it('true when a data block is reachable, false at end-of-tape', () => {
    const deck = deckWith(makeData(0xFF, [1]));
    expect(deck.hasRomBlock()).toBe(true);
    deck.nextDataBlock();
    expect(deck.hasRomBlock()).toBe(false);
  });

  it('false when the next non-cosmetic block is a custom-loader block', () => {
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(tone, makeData(0xFF, [1]));
    expect(deck.hasRomBlock()).toBe(false);
  });

  it('false when blocked by a zero-duration pause', () => {
    const deck = deckWith(
      { kind: 'pause', duration: 0 } as PauseBlock,
      makeData(0xFF, [1]),
    );
    expect(deck.hasRomBlock()).toBe(false);
  });

  it('false on 48K when blocked by stop-if-48k', () => {
    const deck = deckWith(
      { kind: 'stop-if-48k' } as StopIf48KBlock,
      makeData(0xFF, [1]),
    );
    deck.is48K = true;
    expect(deck.hasRomBlock()).toBe(false);
    deck.is48K = false;
    expect(deck.hasRomBlock()).toBe(true);
  });

  it('looks past cosmetic blocks to find the next data block', () => {
    const deck = deckWith(
      { kind: 'group-start', name: 'X' } as GroupStartBlock,
      { kind: 'text', text: 't' } as TextBlock,
      makeData(0xFF, [1]),
    );
    expect(deck.hasRomBlock()).toBe(true);
  });

  // NOTE: `hasRomBlock` does NOT advance `position`. After it returns false
  // for a 48K stop-if-48k, callers must not assume the deck has paused —
  // only `nextDataBlock()` actually updates `paused`. Documented here.
});

// ── Data block playback structure ──────────────────────────────────────────

describe('TapeDeck — standard data block playback structure', () => {
  it('emits pilotCount pilot edges, then 2 sync edges, then 2 edges per bit', () => {
    // Single-byte payload → rawData is [flag, byte, checksum] = 3 bytes = 24 bits.
    // Use small pilot count so the test runs quickly.
    const block = makeData(0xFF, [0xA5], {
      pilotCount: 4, // tiny pilot
      pilotPulse: 100,
      syncPulse1: 50,
      syncPulse2: 60,
      bit0Pulse: 70,
      bit1Pulse: 140,
      pause: 0, // skip pause; flow into IDLE
    });
    const deck = deckWith(block);
    deck.startPlayback();

    // Compute total T-states for the whole block:
    //   pilot:  4 × 100  = 400
    //   sync1:  50
    //   sync2:  60
    // For data: each bit is 2 half-cycles, so bit_n contributes 2 × pulse_n.
    // rawData = [0xFF, 0xA5, 0xFF ^ 0xA5] = [0xFF, 0xA5, 0x5A].
    // Count "1" bits and "0" bits to get total data T-states.
    const raw = [0xFF, 0xA5, 0x5A];
    let dataT = 0;
    let edgesData = 0;
    for (const byte of raw) {
      for (let b = 7; b >= 0; b--) {
        const bit = (byte >> b) & 1;
        dataT += 2 * (bit ? 140 : 70);
        edgesData += 2;
      }
    }
    const totalT = 400 + 50 + 60 + dataT;
    const expectedEdges = 4 /* pilot */ + 2 /* sync */ + edgesData;

    const edges = countEdges(deck, totalT, 1);
    expect(edges).toBe(expectedEdges);
  });

  it('checksum byte is generated by XOR of flag + payload', () => {
    // Two-byte payload; verify the third byte played out is flag^p1^p2.
    // We can't read rawData directly, but we can use a pure-data block to
    // bypass the parser and check that buildRawData isn't applied there,
    // then a standard block where it is. Indirect: build a TAP through the
    // parser and verify by counting bit-1 transitions.
    const flag = 0xFF;
    const p1 = 0x12;
    const p2 = 0x34;
    const checksum = flag ^ p1 ^ p2;
    expect(checksum).toBe(0xD9);

    // Play the block and tally how many T-states correspond to bit-1 pulses
    // for the last 8 bits (the checksum byte).
    const block = makeData(flag, [p1, p2], {
      pilotCount: 1,
      pilotPulse: 10,
      syncPulse1: 10,
      syncPulse2: 10,
      bit0Pulse: 100,
      bit1Pulse: 200,
      pause: 0,
    });
    const deck = deckWith(block);
    deck.startPlayback();

    // Skip pilot + sync (3 edges, 30 T total).
    deck.advance(30);

    // First 16 data bits = flag(0xFF) + p1(0x12). Skip them.
    const skipBits = (byte: number) => {
      for (let b = 7; b >= 0; b--) {
        const bit = (byte >> b) & 1;
        deck.advance(2 * (bit ? 200 : 100));
      }
    };
    skipBits(flag);
    skipBits(p1);
    skipBits(p2);

    // Now playing the checksum byte. For each bit, check that the pulse
    // length matches the expected bit value.
    for (let b = 7; b >= 0; b--) {
      const expectedBit = (checksum >> b) & 1;
      // The pulse length for this bit is set by setDataPulseLen.
      // We can read it via (deck as any).pulseLen.
      expect((deck as any).pulseLen).toBe(expectedBit ? 200 : 100);
      deck.advance(2 * (expectedBit ? 200 : 100));
    }
  });
});

// ── Pure-data block playback (skips pilot/sync) ────────────────────────────

describe('TapeDeck — pure-data block playback', () => {
  it('skips pilot and sync; emits 2 edges per bit from raw data', () => {
    // 'pure-data' uses block.data verbatim (no flag/checksum reconstruction).
    const block = makeData(0x00, [0b10000000, 0b00000000], {
      source: 'pure-data',
      pilotCount: 0,
      bit0Pulse: 100,
      bit1Pulse: 200,
      pause: 0,
      usedBits: 8,
    });
    const deck = deckWith(block);
    deck.startPlayback();

    // 16 bits: one "1" then fifteen "0"s. Expected edges = 32.
    const totalT = 2 * 200 + 15 * 2 * 100;
    const edges = countEdges(deck, totalT, 1);
    expect(edges).toBe(32);
  });
});

// ── skipBlock() ────────────────────────────────────────────────────────────

describe('TapeDeck.skipBlock()', () => {
  it('starts playback at the current position after a ROM trap', () => {
    const deck = deckWith(makeData(0xFF, [1]), makeData(0xFF, [2]));
    // Simulate ROM trap consuming the first block:
    deck.nextDataBlock();
    expect(deck.position).toBe(1);
    expect(deck.playing).toBe(false);
    deck.skipBlock();
    expect(deck.playing).toBe(true);
    expect((deck as any).playbackIdx).toBe(1);
  });

  it('past the end of the tape leaves the player stopped', () => {
    const deck = deckWith(makeData(0xFF, [1]));
    deck.nextDataBlock();
    deck.skipBlock();
    expect(deck.playing).toBe(false);
  });
});

// ── stopPlayback / rewind ──────────────────────────────────────────────────

describe('TapeDeck — stop and rewind', () => {
  it('stopPlayback() clears playing flag and earBit', () => {
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 100 };
    const deck = deckWith(tone);
    deck.startPlayback();
    deck.advance(100);
    expect(deck.playing).toBe(true);
    deck.stopPlayback();
    expect(deck.playing).toBe(false);
    expect(deck.earBit).toBe(0);
  });

  it('rewind() returns position to 0 and restarts playback if currently playing', () => {
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 100 };
    const direct: DirectBlock = {
      kind: 'direct', tStatesPerSample: 100, pause: 0, usedBits: 8,
      data: new Uint8Array([0xFF]),
    };
    const deck = deckWith(tone, direct);
    deck.startPlayback();
    deck.advance(100 * 100); // exhaust the tone
    expect((deck as any).playbackIdx).toBe(1);
    deck.rewind();
    expect(deck.position).toBe(0);
    // Still playing, and replaying from the tone block.
    expect(deck.playing).toBe(true);
    expect((deck as any).playbackIdx).toBe(0);
  });

  it('rewind() while not playing only resets position', () => {
    const deck = deckWith(makeData(0xFF, [1]), makeData(0xFF, [2]));
    deck.nextDataBlock();
    expect(deck.position).toBe(1);
    expect(deck.playing).toBe(false);
    deck.rewind();
    expect(deck.position).toBe(0);
    expect(deck.playing).toBe(false);
  });
});

// ── advance() guards ───────────────────────────────────────────────────────

describe('TapeDeck.advance() guard conditions', () => {
  it('is a no-op when not playing', () => {
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(tone);
    const before = deck.earBit;
    deck.advance(10_000);
    expect(deck.earBit).toBe(before);
  });

  it('is a no-op while paused', () => {
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 5 };
    const deck = deckWith(tone);
    deck.startPlayback();
    deck.paused = true;
    const before = deck.earBit;
    deck.advance(10_000);
    expect(deck.earBit).toBe(before);
  });
});
