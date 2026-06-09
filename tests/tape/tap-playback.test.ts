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
  const d = new TapeDeck(3_500_000);
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
  // 1000ms at the 3.5MHz reference clock the test deck runs at.
  const PAUSE_1000MS_T = Math.round(1000 * 3_500_000 / 1000);

  it('replays the consumed block\'s trailing pause before the next block', () => {
    // After a ROM-trap instant-load, the tape must run out the loaded block's
    // trailing gap in real time before the next block's tone — loaders chained
    // after a ROM block (e.g. Speedlock's BASIC bootstrap) rely on that gap to
    // install their turbo loader before custom data arrives.
    const deck = deckWith(makeData(0xFF, [1], { pause: 1000 }), makeData(0xFF, [2]));
    deck.nextDataBlock();            // ROM trap consumes block 0
    expect(deck.position).toBe(1);
    expect(deck.playing).toBe(false);
    deck.skipBlock();
    expect(deck.playing).toBe(true);
    // Still on the consumed block, running out its trailing pause — NOT yet
    // on block 1.
    expect((deck as any).playbackIdx).toBe(0);
    // Once the pause elapses, playback advances to the next block.
    deck.advance(PAUSE_1000MS_T + 1);
    expect((deck as any).playbackIdx).toBe(1);
  });

  it('begins the next block immediately when the consumed block has no pause', () => {
    const deck = deckWith(makeData(0xFF, [1], { pause: 0 }), makeData(0xFF, [2]));
    deck.nextDataBlock();
    deck.skipBlock();
    expect(deck.playing).toBe(true);
    expect((deck as any).playbackIdx).toBe(1);
  });

  it('plays the final block\'s trailing pause, then stops at end of tape', () => {
    const deck = deckWith(makeData(0xFF, [1], { pause: 1000 }));
    deck.nextDataBlock();
    deck.skipBlock();
    // Still playing — running out the last block's trailing pause.
    expect(deck.playing).toBe(true);
    deck.advance(PAUSE_1000MS_T + 1);
    // Pause elapsed, no more blocks → player stops.
    expect(deck.playing).toBe(false);
  });

  it('stops immediately at end of tape when the final block has no pause', () => {
    const deck = deckWith(makeData(0xFF, [1], { pause: 0 }));
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

// ── Bug: empty direct data block ────────────────────────────────────────────

describe('TapeDeck — bug: empty direct data block', () => {
  it('should skip cleanly instead of reading garbage from an empty array', () => {
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const empty: DirectBlock = {
      kind: 'direct',
      tStatesPerSample: 10,
      pause: 0,
      usedBits: 8,
      data: new Uint8Array(0),
    };
    const deck = deckWith(empty, tone);
    deck.startPlayback();

    // With the bug, the deck would emit 8 garbage samples from the empty
    // array before detecting the out-of-range byte index. After the fix it
    // should skip straight to the tone block.
    expect(deck.playing).toBe(true);
    expect((deck as any).playbackIdx).toBe(1);

    // Verify the tone block is playing normally.
    const edges = countEdges(deck, 100, 1);
    expect(edges).toBe(1);
    expect(deck.playing).toBe(false);
  });
});

// ── usedBits=0 is clamped to 1 (not "skip the entire last byte") ────────────
//
// TZX spec considers usedBits ∈ [1..8] on the final byte. The deck enforces
// `Math.max(1, block.usedBits)` to defend against malformed inputs. The
// historical bug was that usedBits=0 *removed* the last byte entirely;
// the fix made the last byte play 1 bit (its MSB) instead.

describe('TapeDeck — usedBits=0 is clamped to 1 on last byte', () => {
  it('standard data block: only the MSB of the last byte plays', () => {
    // payload = [0x00] → rawData = [flag=0xFF, 0x00, checksum=0xFF].
    // Last byte = 0xFF (checksum). With clamp, only bit 7 (a "1") plays =
    // 2 edges using bit1Pulse = 200T × 2 half-cycles = 400T.
    // Preceding bytes contribute their own edges/T.
    const block = makeData(0xFF, [0x00], {
      pilotCount: 1,
      pilotPulse: 10,
      syncPulse1: 10,
      syncPulse2: 10,
      bit0Pulse: 100,
      bit1Pulse: 200,
      pause: 0,
      usedBits: 0,
    });
    const deck = deckWith(block);
    deck.startPlayback();

    // pilot(1×10T) + sync(10+10T) = 30T, 3 edges.
    // byte 0 (0xFF, eight 1s): 8 × 2 × 200 = 3200T, 16 edges.
    // byte 1 (0x00, eight 0s): 8 × 2 × 100 = 1600T, 16 edges.
    // byte 2 (0xFF, but usedBitsLast=1 → only bit 7): 2 × 200 = 400T, 2 edges.
    const totalT = 30 + 3200 + 1600 + 400;
    const expectedEdges = 3 + 16 + 16 + 2;
    const edges = countEdges(deck, totalT, 1);
    expect(edges).toBe(expectedEdges);
    // After the clamp's single bit on the last byte, advance lands in PAUSE.
    expect((deck as any).phase).toBe(5 /* PAUSE */);
  });

  it('direct block: only the MSB of the last byte plays', () => {
    // 2-byte direct block, usedBits=0 clamped to 1 → second byte emits 1
    // sample only. Total = 8 samples (byte 0) + 1 sample (byte 1) = 9 × 10T = 90T.
    const block: DirectBlock = {
      kind: 'direct',
      tStatesPerSample: 10,
      pause: 0,
      usedBits: 0,
      data: new Uint8Array([0xFF, 0xAA]),
    };
    const deck = deckWith(block);
    deck.startPlayback();
    // At 80T we have just wrapped into byte 1 (initial bit 7).
    deck.advance(80);
    expect(deck.playing).toBe(true);
    // The 9th sample at T=90 enters the isLastByte clamp branch and ends
    // playback (no next block, pause=0).
    deck.advance(10);
    expect(deck.playing).toBe(false);
    // With usedBitsLast=8 it would take 16 samples (160T) to end — verify
    // we ended at 90T, not later.
  });
});

// ── Missing coverage: standard data block with valid usedBits < 8 ────────────

describe('TapeDeck — standard data block with usedBits < 8', () => {
  it('only plays the top N bits of the last byte', () => {
    // rawData = [flag=0x00, checksum=0x00] = 2 bytes, usedBits=3 on last byte.
    // The last byte is the checksum (0x00). Only the top 3 bits should play.
    const block = makeData(0x00, [], {
      pilotCount: 1,
      pilotPulse: 10,
      syncPulse1: 10,
      syncPulse2: 10,
      bit0Pulse: 100,
      bit1Pulse: 100,
      pause: 0,
      usedBits: 3,
    });
    const deck = deckWith(block);
    deck.startPlayback();

    // Skip pilot + sync (3 edges, 30T).
    deck.advance(30);

    // rawData = [0x00, 0x00] = 2 bytes = 16 bits, but last byte only uses 3.
    // So: first byte = 8 bits (16 edges), last byte = 3 bits (6 edges).
    // Total: 22 edges, all at 100T (bit0Pulse=bit1Pulse=100).
    const totalDataT = (8 + 3) * 2 * 100;
    const edges = countEdges(deck, totalDataT, 1);
    expect(edges).toBe(22);
  });
});

// ── Missing coverage: data block pause > 0 transitions to next block ────────

describe('TapeDeck — data block pause elapses into next block', () => {
  it('after data, pause elapses and the next block starts playing', () => {
    const block1 = makeData(0xFF, [0x00], {
      pilotCount: 1,
      pilotPulse: 10,
      syncPulse1: 10,
      syncPulse2: 10,
      bit0Pulse: 10,
      bit1Pulse: 10,
      pause: 1, // 1ms = 3500 T at 3.5MHz
    });
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(block1, tone);
    deck.startPlayback();

    // Pilot(1×10T) + sync(10+10T) + data(3 bytes × 8 bits × 2 × 10T) = 20+480 = 500T
    // (rawData = [0xFF, 0x00, 0xFF] = 3 bytes = 24 bits × 2 edges × 10T = 480T)
    const pilotSyncT = 10 + 10 + 10;
    const dataT = 3 * 8 * 2 * 10;
    deck.advance(pilotSyncT + dataT);

    // Now in PAUSE phase (1ms = 3500T).
    expect((deck as any).phase).toBe(5); // TapePhase.PAUSE = 5
    expect(deck.position).toBe(1);

    // Elapse the pause.
    deck.advance(3500);
    // Should have transitioned to the tone block.
    expect((deck as any).playbackIdx).toBe(1);
    expect((deck as any).phase).toBe(6); // TapePhase.TONE = 6
  });
});

// ── Missing coverage: advance() spanning multiple phases in one call ────────

describe('TapeDeck — large advance() spanning phases', () => {
  it('processes pilot+sync+data+pause in a single advance() call', () => {
    const block = makeData(0xFF, [0x00], {
      pilotCount: 2,
      pilotPulse: 10,
      syncPulse1: 10,
      syncPulse2: 10,
      bit0Pulse: 10,
      bit1Pulse: 10,
      pause: 0,
    });
    const deck = deckWith(block);
    deck.startPlayback();

    // Advance by more than the entire block (pilot+sync+data).
    const totalT = 10 * 2 + 10 + 10 + 3 * 8 * 2 * 10;
    deck.advance(totalT);
    // Now in PAUSE phase (pause=0); needs one more advance to process it.
    expect((deck as any).phase).toBe(5); // TapePhase.PAUSE
    deck.advance(1);
    // Block finished, no next block → playing=false.
    expect(deck.playing).toBe(false);
  });
});

// ── Missing coverage: multi-byte direct block ───────────────────────────────

describe('TapeDeck — multi-byte direct block', () => {
  it('plays all bits of all bytes sequentially', () => {
    const block: DirectBlock = {
      kind: 'direct',
      tStatesPerSample: 10,
      pause: 0,
      usedBits: 8,
      data: new Uint8Array([0b11001100, 0b10101010]),
    };
    const deck = deckWith(block);
    deck.startPlayback();

    // First byte: 1,1,0,0,1,1,0,0 → 8 samples × 10T = 80T
    // Second byte: 1,0,1,0,1,0,1,0 → 8 samples × 10T = 80T
    // Total: 160T
    const observed: number[] = [];
    for (let i = 0; i < 16; i++) {
      observed.push(deck.earBit);
      deck.advance(10);
    }
    // First 8 bits from byte 0, next 8 from byte 1.
    expect(observed.slice(0, 8)).toEqual([1, 1, 0, 0, 1, 1, 0, 0]);
    expect(observed.slice(8, 16)).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
  });

  it('usedBits=3 on last byte of multi-byte direct block', () => {
    const block: DirectBlock = {
      kind: 'direct',
      tStatesPerSample: 10,
      pause: 0,
      usedBits: 3,
      data: new Uint8Array([0xFF, 0b101_00000]),
    };
    const deck = deckWith(block);
    deck.startPlayback();

    // 8 samples for first byte + 3 samples for second = 11 total × 10T = 110T.
    // 11th sample ends the block. After that, playing=false.
    deck.advance(110);
    expect(deck.playing).toBe(false);
  });
});

// ── Bug: recursive beginBlock for consecutive cosmetic blocks ───────────────

describe('TapeDeck — robustness: many consecutive cosmetic blocks', () => {
  it('handles 500 consecutive cosmetic blocks without stack overflow', () => {
    const cosmetic: TapeBlock[] = [];
    for (let i = 0; i < 500; i++) {
      cosmetic.push({ kind: 'group-start', name: `g${i}` } as GroupStartBlock);
    }
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(...cosmetic, tone);
    deck.startPlayback();
    // If beginBlock recurses for each cosmetic block, 500 will likely stack
    // overflow. After fix (iterative), this should reach the tone block.
    expect(deck.playing).toBe(true);
    expect((deck as any).playbackIdx).toBe(500); // tone block
  });
});

// ── tStatesToNextEdge() — surgical-loader edge predictor ────────────────────

describe('TapeDeck.tStatesToNextEdge()', () => {
  it('returns null when not playing', () => {
    const deck = deckWith({ kind: 'tone', pulseLen: 100, count: 1 } as ToneBlock);
    expect(deck.tStatesToNextEdge()).toBeNull();
  });

  it('returns null while paused', () => {
    const deck = deckWith({ kind: 'tone', pulseLen: 100, count: 1 } as ToneBlock);
    deck.startPlayback();
    deck.paused = true;
    expect(deck.tStatesToNextEdge()).toBeNull();
  });

  it('returns null in IDLE phase (no blocks)', () => {
    const deck = new TapeDeck(3_500_000);
    // Force playing=true but phase=IDLE — startPlayback with no blocks goes IDLE.
    deck.startPlayback();
    expect(deck.tStatesToNextEdge()).toBeNull();
  });

  it('returns null during PAUSE phase', () => {
    const pause: PauseBlock = { kind: 'pause', duration: 10 };
    const deck = deckWith(pause);
    deck.startPlayback();
    // Now in PAUSE phase.
    expect((deck as any).phase).toBe(5 /* PAUSE */);
    expect(deck.tStatesToNextEdge()).toBeNull();
  });

  it('returns null during DIRECT phase (sample boundaries, not edges)', () => {
    const direct: DirectBlock = {
      kind: 'direct', tStatesPerSample: 100, pause: 0, usedBits: 8,
      data: new Uint8Array([0xFF]),
    };
    const deck = deckWith(direct);
    deck.startPlayback();
    expect(deck.tStatesToNextEdge()).toBeNull();
  });

  it('returns full pulseLen at the start of a pulse', () => {
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 5 };
    const deck = deckWith(tone);
    deck.startPlayback();
    expect(deck.tStatesToNextEdge()).toBe(100);
  });

  it('decreases as the pulse is consumed', () => {
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 5 };
    const deck = deckWith(tone);
    deck.startPlayback();
    deck.advance(40);
    expect(deck.tStatesToNextEdge()).toBe(60);
  });

  it('returns 0 when the edge is overdue', () => {
    // Direct manipulation: load a pulse-mode phase then force tInPulse past
    // pulseLen without calling advance(). The accessor must clamp at 0.
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 5 };
    const deck = deckWith(tone);
    deck.startPlayback();
    (deck as any).tInPulse = 200;
    expect(deck.tStatesToNextEdge()).toBe(0);
  });
});

// ── onPlayStateChange listener ──────────────────────────────────────────────

describe('TapeDeck.onPlayStateChange listener', () => {
  it('fires on startPlayback and stopPlayback', () => {
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const deck = deckWith(tone);
    let calls = 0;
    deck.onPlayStateChange = () => { calls++; };
    deck.startPlayback();
    expect(calls).toBe(1);
    deck.stopPlayback();
    expect(calls).toBe(2);
  });

  it('load() triggers stopPlayback which notifies the listener', () => {
    const deck = new TapeDeck(3_500_000);
    let calls = 0;
    deck.onPlayStateChange = () => { calls++; };
    // load → stopPlayback → onPlayStateChange.
    deck.load(new Uint8Array(0));
    expect(calls).toBe(1);
  });
});

// ── onEdgeScheduled listener + edge-flag categorisation ─────────────────────

describe('TapeDeck.onEdgeScheduled listener — edge flag categorisation', () => {
  it('classifies pilot as long, sync as short, and data bits by value', () => {
    // 1-byte payload, tiny pilot so the sequence is observable.
    // rawData = [flag=0xFF (all 1s), 0x00 (all 0s), checksum=0xFF (all 1s)].
    const block = makeData(0xFF, [0x00], {
      pilotCount: 2,
      pilotPulse: 100,
      syncPulse1: 50,
      syncPulse2: 60,
      bit0Pulse: 70,
      bit1Pulse: 140,
      pause: 0,
    });
    const deck = deckWith(block);

    const flags: string[] = [];
    deck.onEdgeScheduled = (f) => { flags.push(f); };

    deck.startPlayback();
    // Drain the whole block; tone/pulses/direct/pause/idle emit 'unknown'.
    deck.advance(100 * 2 + 50 + 60 + 3 * 8 * 2 * 140);

    // First flag = entry edge ('long' = pilot).
    expect(flags[0]).toBe('long');
    // Pilot → sync transition emits 'short'.
    expect(flags).toContain('short');
    // Data byte 0 (0xFF, all 1s) emits 'long' on each bit; bytes with zero
    // bits emit 'short'. So both must be present.
    expect(flags).toContain('short');
    expect(flags).toContain('long');
    // After data, enterPause publishes 'unknown'.
    expect(flags[flags.length - 1]).toBe('unknown');
  });

  it('publishes inAcceleration=true when the deck flag is set', () => {
    const block = makeData(0xFF, [0xFF], {
      pilotCount: 1, pilotPulse: 10, syncPulse1: 10, syncPulse2: 10,
      bit0Pulse: 10, bit1Pulse: 10, pause: 0,
    });
    const deck = deckWith(block);
    const accelObserved: boolean[] = [];
    deck.onEdgeScheduled = (_f, fromAccel) => { accelObserved.push(fromAccel); };

    deck.inAcceleration = true;
    deck.startPlayback();
    expect(accelObserved.length).toBeGreaterThan(0);
    expect(accelObserved.every(v => v === true)).toBe(true);
  });

  it('emits "unknown" for tone/pulses/pause/direct blocks', () => {
    const tone: ToneBlock = { kind: 'tone', pulseLen: 100, count: 1 };
    const pulses: PulsesBlock = { kind: 'pulses', lengths: [50, 60] };
    const pause: PauseBlock = { kind: 'pause', duration: 1 };
    const direct: DirectBlock = {
      kind: 'direct', tStatesPerSample: 10, pause: 0, usedBits: 8,
      data: new Uint8Array([0xFF]),
    };
    const deck = deckWith(tone, pulses, pause, direct);
    const flags: string[] = [];
    deck.onEdgeScheduled = (f) => { flags.push(f); };
    deck.startPlayback();
    // Tone start → 'unknown'.
    expect(flags[0]).toBe('unknown');
    // All flags should be 'unknown' since no data/pilot/sync ever runs.
    expect(flags.every(f => f === 'unknown')).toBe(true);
  });

  it('emits "long" for a bit-1 in the data phase', () => {
    // Single-byte payload 0x80 → rawData = [flag=0x80, 0x80, cs=0x00].
    // First data bit is bit 7 of 0x80 = 1 → 'long'.
    const block = makeData(0x80, [0x80], {
      pilotCount: 1, pilotPulse: 10, syncPulse1: 10, syncPulse2: 10,
      bit0Pulse: 70, bit1Pulse: 140, pause: 0,
    });
    const deck = deckWith(block);
    const flags: string[] = [];
    deck.onEdgeScheduled = (f) => { flags.push(f); };
    deck.startPlayback();

    // pilot(1) → sync1 → sync2 → first data bit.
    // First publish from beginDataBlock = 'long' (pilot).
    // Then advancePulse to sync1: 'short'. To sync2: 'short'. To DATA bit 7 = 'long'.
    deck.advance(10);   // pilot done → sync1
    deck.advance(10);   // sync1 → sync2
    deck.advance(10);   // sync2 → DATA bit 7 (=1, 'long')
    // The most recent flag should be 'long'.
    expect(flags[flags.length - 1]).toBe('long');
  });
});

// ── peekDataBlock / nextDataBlock cosmetic skip + 48K-no-stop ───────────────

describe('TapeDeck.peekDataBlock() / nextDataBlock() cosmetic-block traversal', () => {
  it('skips cosmetic blocks to reach the next data block', () => {
    const deck = deckWith(
      { kind: 'group-start', name: 'X' } as GroupStartBlock,
      { kind: 'text', text: 't' } as TextBlock,
      { kind: 'archive-info', entries: [] } as ArchiveInfoBlock,
      { kind: 'group-end' } as GroupEndBlock,
      makeData(0xFF, [42]),
    );
    const b = deck.nextDataBlock();
    expect(b?.data[0]).toBe(42);
    expect(deck.position).toBe(5);
  });

  it('on 128K, stop-if-48k is transparent and the data block is returned', () => {
    const deck = deckWith(
      { kind: 'stop-if-48k' } as StopIf48KBlock,
      makeData(0xFF, [7]),
    );
    deck.is48K = false;
    const b = deck.nextDataBlock();
    expect(b?.data[0]).toBe(7);
    expect(deck.paused).toBe(false);
  });
});

// ── skipBlock() when already playing ────────────────────────────────────────

describe('TapeDeck.skipBlock() when already playing', () => {
  it('does not run the playing=true / earBit=0 reinit when already playing', () => {
    const deck = deckWith(makeData(0xFF, [1]), makeData(0xFF, [2]));
    deck.startPlayback();
    // Move earBit to 1 deliberately and confirm skipBlock does not force it to
    // 0 via the not-yet-playing reinit branch.
    deck.earBit = 1;
    deck.position = 1;       // simulate post-trap advance
    deck.skipBlock();
    expect(deck.playing).toBe(true);
    // earBit was not cleared to 0 by the reinit branch (the pause branch sets
    // it high to drive the end-of-block drop).
    expect(deck.earBit).toBe(1);
    // The consumed block (index 0) has a 1000ms pause, so skipBlock runs that
    // out before advancing — still on the consumed block here.
    expect((deck as any).playbackIdx).toBe(0);
    deck.advance(Math.round(1000 * 3_500_000 / 1000) + 1);
    expect((deck as any).playbackIdx).toBe(1);
  });
});

// ── set-level followed by cosmetic blocks ───────────────────────────────────

describe('TapeDeck — set-level interaction with cosmetic chain', () => {
  it('sets earBit and continues iterating past cosmetic blocks to the next emitter', () => {
    const deck = deckWith(
      { kind: 'set-level', level: 1 } as SetLevelBlock,
      { kind: 'text', text: 'x' } as TextBlock,
      { kind: 'tone', pulseLen: 100, count: 1 } as ToneBlock,
    );
    deck.startPlayback();
    expect(deck.earBit).toBe(1);
    expect((deck as any).playbackIdx).toBe(2);
  });
});

// ── set-level inside playback path (visible after stopPlayback reset) ───────

describe('TapeDeck — earBit reset by stopPlayback', () => {
  it('stopPlayback clears earBit to 0 even if it was set high', () => {
    const deck = deckWith(
      { kind: 'set-level', level: 1 } as SetLevelBlock,
      { kind: 'tone', pulseLen: 100, count: 1 } as ToneBlock,
    );
    deck.startPlayback();
    expect(deck.earBit).toBe(1);
    deck.stopPlayback();
    expect(deck.earBit).toBe(0);
  });
});

// ── Direct block transition into PAUSE on last byte with pause > 0 ──────────

describe('TapeDeck — direct block last-byte → PAUSE with non-zero pause', () => {
  it('enters PAUSE with cpuClock-scaled pauseRemaining and earBit=0', () => {
    const block: DirectBlock = {
      kind: 'direct', tStatesPerSample: 10, pause: 2, usedBits: 8,
      data: new Uint8Array([0xFF]),
    };
    const deck = deckWith(block);
    deck.startPlayback();
    deck.advance(80); // exhaust the byte
    expect((deck as any).phase).toBe(5 /* PAUSE */);
    expect(deck.earBit).toBe(0);
    // 2ms × 3.5MHz = 7000T.
    expect((deck as any).pauseRemaining).toBe(7000);
  });
});

// ── Data-block pause flip — mid-flip decrement ──────────────────────────────

describe('TapeDeck — data block pause: mid-flip decrement leaves flip pending', () => {
  it('pauseFlipAt decrements without firing the earBit drop until it reaches 0', () => {
    // pause=1ms = 3500T at 3.5MHz. enterPause schedules pauseFlipAt=945
    // (since 3500 > 945). Stepping fewer than 945T must decrement but not
    // yet zero out — this exercises the `pauseFlipAt > 0 && <= 0` else path.
    const block = makeData(0xFF, [0xFF], {
      pilotCount: 1, pilotPulse: 10, syncPulse1: 10, syncPulse2: 10,
      bit0Pulse: 10, bit1Pulse: 10, pause: 1,
    });
    const deck = deckWith(block);
    deck.startPlayback();

    // Consume pilot+sync+data → enter PAUSE.
    // rawData = [0xFF, 0xFF, 0x00] = 3 bytes = 24 bits × 2 × 10T = 480T.
    deck.advance(10 + 10 + 10 + 480);
    expect((deck as any).phase).toBe(5 /* PAUSE */);
    expect((deck as any).pauseFlipAt).toBe(945);
    const earBeforeFlip = deck.earBit;

    // Step 100T into the pause — flip should NOT yet have happened.
    deck.advance(100);
    expect((deck as any).pauseFlipAt).toBe(845);
    expect(deck.earBit).toBe(earBeforeFlip);

    // Step past the flip threshold; flip fires, pauseFlipAt resets to -1.
    deck.advance(900);
    expect((deck as any).pauseFlipAt).toBe(-1);
    expect(deck.earBit).toBe(0);
  });
});

// ── parser: a final block whose declared length equals exactly the remainder ─

describe('TAP parser — exact-fit final block', () => {
  it('parses a block where blockLen consumes the file to its last byte', () => {
    // 4-byte payload + flag + checksum = blockLen 6. Total file = 8 bytes.
    const tap = new Uint8Array([0x06, 0x00, 0xFF, 1, 2, 3, 4, 0xFF ^ 1 ^ 2 ^ 3 ^ 4]);
    const deck = new TapeDeck(3_500_000);
    const blocks = deck.parseTAP(tap);
    expect(blocks.length).toBe(1);
    expect((blocks[0] as DataBlock).data.length).toBe(4);
  });
});
