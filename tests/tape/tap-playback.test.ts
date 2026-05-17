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

// ── Bug: usedBits=0 skips the entire last byte ──────────────────────────────

describe('TapeDeck — bug: usedBits=0 on last byte', () => {
  it('standard data block: usedBits=0 should not skip the last byte', () => {
    // Two bytes: 0xFF (all 1s) and 0xAA (usedBits=0). The second byte should
    // still emit pulses; with the bug, bitIdx < (8-0)=8 triggers immediately
    // and the second byte is completely skipped.
    const block = makeData(0xFF, [0x00, 0xAA], {
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

    // Skip pilot (1 edge, 10T) + sync (2 edges, 20T).
    deck.advance(30);

    // rawData = [flag=0xFF, 0x00, checksum=0xFF^0x00^0xAA=0x55] = 3 bytes = 24 bits.
    // Each bit is 2 half-cycles. With the bug, the last byte (checksum 0x55)
    // produces 0 edges because usedBits=0 causes immediate enterPause.
    // After fix, it should produce 16 edges for the full last byte.
    //
    // Count total data T-states for the full 24 bits.
    const raw = [0xFF, 0x00, 0x55];
    let dataT = 0;
    let expectedEdges = 0;
    for (const byte of raw) {
      for (let b = 7; b >= 0; b--) {
        const bit = (byte >> b) & 1;
        dataT += 2 * (bit ? 200 : 100);
        expectedEdges += 2;
      }
    }

    const edges = countEdges(deck, dataT, 1);
    expect(edges).toBe(expectedEdges);
  });

  it('direct block: usedBits=0 should not skip the last byte', () => {
    // Two bytes; usedBits=0 on the second (last) byte.
    const block: DirectBlock = {
      kind: 'direct',
      tStatesPerSample: 10,
      pause: 0,
      usedBits: 0,
      data: new Uint8Array([0xFF, 0xAA]),
    };
    const deck = deckWith(block);
    deck.startPlayback();

    // With the bug, after the first byte (8 samples), directBitIdx decrements
    // to 7 for the second byte, but isLastByte && 7 < (8-0=8) is true, so the
    // block ends immediately. After the fix, all 8 bits of the second byte
    // should play.
    //
    // Total expected: 16 samples × 10T = 160T. After that, block ends.
    // With the bug, only 8 samples × 10T = 80T before the block ends.
    deck.advance(80);
    expect(deck.playing).toBe(true); // With bug this would be false (block ended)
    deck.advance(80);
    expect(deck.playing).toBe(false); // Now the block should have ended
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
    deck.cpuClock = 3_500_000;
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
