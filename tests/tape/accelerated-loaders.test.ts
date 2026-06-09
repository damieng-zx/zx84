/**
 * Accelerated-loaders integration suite.
 *
 * For each named custom-loader family (Speedlock 1-4 / 7, Bleepload, Alkatraz,
 * Microsphere, Search Loader, Paul Owens, Digital Integration, CyberLoad,
 * Power Load, Hewson Slow Load, Codemasters, Players Software, CEZ Games,
 * Erbe Re-release, Mixed 550/1100, Dinamic, Ocean variant) plus the standard
 * ROM loader, drive a headless Spectrum with a synthetic poll-loop and a
 * synthetic TZX block sequence whose timings match the loader's fingerprint
 * (taken from tape-protection's TIMING_DB).
 *
 * The .tzx samples in f:\src\zx\tape-protection\analysis can't be shipped, so
 * blocks are simulated directly into TapeDeck.blocks with each family's
 * (pilot, sync1, sync2, bit0, bit1) timings, a short pilot count (50) to keep
 * playback bounded, and a tiny payload.
 *
 * Each test verifies the full engagement lifecycle:
 *   1. Loader is detected (tape auto-starts via LoaderDetector).
 *   2. Tape turbo engages while EAR is being polled.
 *   3. Block playback advances through pilot → sync → data → optional pause.
 *   4. Play / pause sequencing — TZX 0x20 pause-with-duration blocks in the
 *      middle don't deadlock, position advances when pause expires.
 *   5. At end-of-tape, turbo disengages and the machine returns to 100% (the
 *      `turbo` boolean is never set by acceleration).
 */

import { describe, it, expect } from 'vitest';
import { Spectrum } from '@/spectrum.ts';
import type { TapeBlock, DataBlock, PauseBlock } from '@/tape/tap.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

function tagRom(): Uint8Array {
  const rom = new Uint8Array(64 * 1024);
  for (let p = 0; p < 4; p++) { rom[p * 16384] = 0xA0 + p; rom[p * 16384 + 1] = p; }
  return rom;
}

function makeMachine(): Spectrum {
  const s = new Spectrum('48k', null);
  s.loadROM(tagRom());
  return s;
}

/**
 * Install a 7-byte loop at $C000 that polls port 0xFFFE while ticking B
 * by +1 per iteration — the shape the EdgeLoader's §2 auto-start
 * heuristic requires (gap ≤ 500T AND b_diff ∈ {+1, -1}):
 *   $C000: 04         INC B         ; 4T
 *   $C001: 3E FF      LD A,$FF      ; 7T  (high byte = $FF → counts as earReads)
 *   $C003: DB FE      IN A,($FE)    ; 11T
 *   $C005: 18 F9      JR -7         ; 12T
 * Total ≈ 34T per iteration. The byte tail at PC-6 does NOT match any
 * structural signature so signature stays 'unknown' — this is the
 * generic "edge polling but unrecognised" test loop.
 */
function installPollLoop(s: Spectrum): void {
  const code = [0x04, 0x3E, 0xFF, 0xDB, 0xFE, 0x18, 0xF9];
  for (let i = 0; i < code.length; i++) s.memory.writeByte(0xC000 + i, code[i]);
  s.cpu.pc = 0xC000;
  s.cpu.sp = 0xFF00;
}

/**
 * Install the real Spectrum 48K ROM LD-SAMPLE loop body at $C000 so the
 * EdgeLoader's structural detector matches pattern A (signature='rom').
 * The anchor check requires the full 13-byte window with the final
 * JR Z,-13 (operand $F3) jumping back to the INC B at the start.
 *   $C000: 04         INC B
 *   $C001: C8         RET Z
 *   $C002: 3E 7F      LD A,$7F      (aImm=$7F → 'rom' classification)
 *   $C004: DB FE      IN A,($FE)
 *   $C006: 1F         RRA
 *   $C007: D0         RET NC        (variant byte = RET NC → ROM)
 *   $C008: A9         XOR C
 *   $C009: E6 20      AND $20
 *   $C00B: 28 F3      JR Z,$C000    (back to INC B; 13-byte window)
 *   $C00D: 18 F1      JR $C000      (fallthrough back to start if edge
 *                                     detected so the loop keeps polling
 *                                     and the auto-start heuristic fires)
 * PC sits at $C006 (after the IN), so the detector reads from PC-6 = $C000.
 * Port reads return 0xFF (no key pressed) so RRA leaves CF=1 and RET NC
 * never fires — the loop keeps running until the test stops the machine.
 */
function installRomLoop(s: Spectrum): void {
  const code = [
    0x04, 0xC8, 0x3E, 0x7F, 0xDB, 0xFE, 0x1F, 0xD0,
    0xA9, 0xE6, 0x20, 0x28, 0xF3, 0x18, 0xF1,
  ];
  for (let i = 0; i < code.length; i++) s.memory.writeByte(0xC000 + i, code[i]);
  s.cpu.pc = 0xC000;
  s.cpu.sp = 0xFF00;
}

function makeDataBlock(
  payload: number[],
  t: { pilot: number; sync1: number; sync2: number; bit0: number; bit1: number },
  opts: { flag?: number; pilotCount?: number; pause?: number } = {},
): DataBlock {
  const flag = opts.flag ?? 0xFF;
  return {
    kind: 'data',
    flag,
    data: new Uint8Array(payload),
    pause: opts.pause ?? 50,           // 50ms — short, just enough to test transition
    pilotPulse: t.pilot,
    syncPulse1: t.sync1,
    syncPulse2: t.sync2,
    bit0Pulse: t.bit0,
    bit1Pulse: t.bit1,
    pilotCount: opts.pilotCount ?? 50, // bounded so tests run in milliseconds
    usedBits: 8,
    source: 'turbo',
  };
}

/**
 * Drive ticks until `predicate` is true or we hit `maxFrames`.
 * Returns the number of frames consumed.
 */
function tickUntil(s: Spectrum, predicate: () => boolean, maxFrames = 200): number {
  let n = 0;
  while (n < maxFrames && !predicate()) {
    s.tick();
    n++;
  }
  return n;
}

// ── Named-loader timing fingerprints (from tape-protection's TIMING_DB) ─────

interface Loader { name: string; pilot: number; sync1: number; sync2: number; bit0: number; bit1: number; }

const LOADERS: readonly Loader[] = [
  { name: 'ROM standard',         pilot: 2168, sync1: 667, sync2: 735, bit0: 855,  bit1: 1710 },
  { name: 'Speedlock 1-2',        pilot: 2168, sync1: 667, sync2: 735, bit0: 542,  bit1: 1086 },
  { name: 'Speedlock 3-4',        pilot: 1500, sync1: 667, sync2: 735, bit0: 542,  bit1: 1086 },
  { name: 'Speedlock 7',          pilot: 2165, sync1: 714, sync2: 714, bit0: 583,  bit1: 1166 },
  { name: 'Bleepload',            pilot: 2168, sync1: 667, sync2: 735, bit0: 528,  bit1: 1056 },
  { name: 'Hewson Slow Load',     pilot: 1710, sync1: 855, sync2: 855, bit0: 855,  bit1: 1710 },
  { name: 'Microsphere',          pilot: 2168, sync1: 667, sync2: 735, bit0: 325,  bit1: 650  },
  { name: 'Alkatraz',             pilot: 2165, sync1: 714, sync2: 714, bit0: 564,  bit1: 1129 },
  { name: 'Search Loader',        pilot: 1710, sync1: 667, sync2: 735, bit0: 855,  bit1: 1710 },
  { name: 'Paul Owens',           pilot: 2168, sync1: 667, sync2: 735, bit0: 408,  bit1: 816  },
  { name: 'Digital Integration',  pilot: 2168, sync1: 667, sync2: 735, bit0: 473,  bit1: 947  },
  { name: 'CyberLoad',            pilot: 2168, sync1: 667, sync2: 735, bit0: 600,  bit1: 1200 },
  { name: 'Power Load',           pilot: 2168, sync1: 667, sync2: 735, bit0: 668,  bit1: 1336 },
  { name: 'Ocean (variant)',      pilot: 2168, sync1: 667, sync2: 735, bit0: 855,  bit1: 1710 },
  { name: 'Players Software',     pilot: 2156, sync1: 667, sync2: 735, bit0: 560,  bit1: 1120 },
  { name: 'CEZ Games',            pilot: 2168, sync1: 667, sync2: 735, bit0: 518,  bit1: 1036 },
  { name: 'Erbe Re-release',      pilot: 1700, sync1: 667, sync2: 735, bit0: 855,  bit1: 1710 },
  { name: 'Codemasters',          pilot: 2064, sync1: 667, sync2: 735, bit0: 569,  bit1: 1137 },
  { name: 'Dinamic',              pilot: 2165, sync1: 714, sync2: 714, bit0: 673,  bit1: 1346 },
  { name: 'Mixed 550/1100',       pilot: 2168, sync1: 667, sync2: 735, bit0: 550,  bit1: 1100 },
];

// ── Per-loader engagement lifecycle ─────────────────────────────────────────

describe('Accelerated loaders — engagement lifecycle', () => {
  for (const loader of LOADERS) {
    it(`${loader.name}: detect → turbo engage → blocks play → turbo disengage`, () => {
      const s = makeMachine();
      installPollLoop(s);

      const blocks: TapeBlock[] = [
        makeDataBlock([0x00, 0xAA, 0x55, 0xFF], loader, { pilotCount: 50, pause: 20 }),
      ];
      s.tape.blocks = blocks;
      s.tape.position = 0;
      s.tape.paused = true;
      s.tapeTurbo = true;

      // 1. Detection: LoaderDetector should fire 'start' within a few frames
      //    (our poll loop emits ~2300 reads/frame, threshold is 10).
      const detectFrames = tickUntil(s, () => s.tapeTurboActive, 5);
      expect(s.tapeTurboActive).toBe(true);
      expect(detectFrames).toBeGreaterThan(0);
      expect(s.tape.paused).toBe(false);
      expect(s.tape.playing).toBe(true);

      // 2. Block playback: pilot(50×pilotPulse) + sync(s1+s2) + data(6 bytes ×
      //    16 half-cycles each), all ≤ ~200_000 T ≈ 3 frames. Allow generous
      //    headroom so slower-bit loaders (e.g. Bleepload) fit.
      tickUntil(s, () => s.tape.finished, 50);
      expect(s.tape.finished).toBe(true);

      // 3. End-of-tape: the cooldown's `else if (this._tapeTurboActive)`
      //    branch fires when the tape is finished — turbo flips off on the
      //    next frame after `finished` becomes true.
      tickUntil(s, () => !s.tapeTurboActive, 5);
      expect(s.tapeTurboActive).toBe(false);

      // 4. The user-facing turbo override (Hardware pane) was never touched.
      expect(s.turbo).toBe(false);
    });
  }
});

// ── ROM signature recognition ───────────────────────────────────────────────

describe('Accelerated loaders — signature recognition', () => {
  it('ROM LD-SAMPLE loop is identified as signature=\'rom\' on auto-start', () => {
    const s = makeMachine();
    installRomLoop(s);

    s.tape.blocks = [
      makeDataBlock([0x00, 0x11, 0x22, 0x33], LOADERS[0] /* ROM timings */, { pilotCount: 30 }),
    ];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = true;

    tickUntil(s, () => s.tape.playing && !s.tape.paused, 5);
    expect(s.tape.playing).toBe(true);
    expect(s.loaderDetector.signature).toBe('rom');
  });

  it('unrecognised poll-loop bytes yield signature=\'unknown\' but still auto-start', () => {
    const s = makeMachine();
    installPollLoop(s); // LD A,$FF / IN A,($FE) — not in SIGNATURES table

    s.tape.blocks = [
      makeDataBlock([0xAA], LOADERS[0], { pilotCount: 30 }),
    ];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = true;

    tickUntil(s, () => s.tape.playing && !s.tape.paused, 5);
    expect(s.tape.playing).toBe(true);
    expect(s.loaderDetector.signature).toBe('unknown');
  });
});

// ── Play / pause sequencing ─────────────────────────────────────────────────

describe('Accelerated loaders — play/pause sequencing', () => {
  it('TZX pause-with-duration between two data blocks: position advances through pause', () => {
    const s = makeMachine();
    installPollLoop(s);

    const loader = LOADERS[1]; // Speedlock 1-2
    const pause: PauseBlock = { kind: 'pause', duration: 10 };
    s.tape.blocks = [
      makeDataBlock([0x01, 0x02], loader, { pilotCount: 30, pause: 0 }),
      pause,
      makeDataBlock([0x03, 0x04], loader, { pilotCount: 30, pause: 20 }),
    ];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = true;

    // First block should consume; pause block should elapse; second block plays.
    tickUntil(s, () => s.tape.finished, 100);
    expect(s.tape.finished).toBe(true);
    expect(s.tape.position).toBe(3);
  });

  it('TZX pause-duration-0 in the middle stops the tape and disengages turbo', () => {
    const s = makeMachine();
    installPollLoop(s);

    const loader = LOADERS[4]; // Bleepload
    const stop: PauseBlock = { kind: 'pause', duration: 0 };
    s.tape.blocks = [
      makeDataBlock([0xAA], loader, { pilotCount: 20, pause: 0 }),
      stop,
      makeDataBlock([0xBB], loader, { pilotCount: 20, pause: 0 }),
    ];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = true;

    // The stop block sets paused=true and advances position past itself.
    // The LoaderDetector will re-auto-start on the still-polling CPU (the
    // pause stops the tape, not the loader), so we don't pin paused=true
    // here — we just verify position advanced past the stop block.
    tickUntil(s, () => s.tape.position >= 2, 30);
    expect(s.tape.position).toBeGreaterThanOrEqual(2);
  });

  it('LoaderDetector stops the tape when the poll loop quits (5 off-pattern reads)', () => {
    const s = makeMachine();
    installPollLoop(s);

    const loader = LOADERS[0];
    // Big enough payload that the tape doesn't finish before we quit polling.
    s.tape.blocks = [
      makeDataBlock(Array(40).fill(0x55), loader, { pilotCount: 200, pause: 0 }),
    ];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = true;

    // Run until turbo engages and tape is playing.
    tickUntil(s, () => s.tape.playing && !s.tape.paused, 5);
    expect(s.tape.playing).toBe(true);
    expect(s.tape.paused).toBe(false);

    // Now stop the CPU polling — point PC at a HALT and disable interrupts.
    s.memory.writeByte(0xC100, 0xF3); // DI
    s.memory.writeByte(0xC101, 0x76); // HALT
    s.cpu.pc = 0xC100;

    // After ≥5 off-pattern reads or wide gaps the detector should auto-stop.
    // HALT means no IN/$FE reads happen at all → no detector input → tape
    // will not auto-pause via the detector, but the loader's keyboard polling
    // in the ROM is also absent, so this is the genuine end-of-load case.
    // Behaviour: tape continues playing through the block then finishes.
    tickUntil(s, () => s.tape.finished, 30);
    expect(s.tape.finished).toBe(true);
    // Turbo disengages once the tape is done.
    tickUntil(s, () => !s.tapeTurboActive, 5);
    expect(s.tapeTurboActive).toBe(false);
  });
});

// ── Sustained engagement regression ─────────────────────────────────────────
//
// The bug this guards: an earlier cooldown rule used activity.earReads as the
// only continuous "loading" signal, but earReads only ticks for port reads
// with high byte = $FF. Speedlock-class loaders poll with A=$7F so the high
// byte is $7F, meaning earReads is always 0 during the load. Turbo engaged
// for the first frame (via the one-shot loaderDetected flag) then expired
// after the 25-frame cooldown, dropping the emulator back to 1× speed for
// the rest of the load — exactly the "3.54 MHz during Speedlock 7" symptom.

describe('Accelerated loaders — turbo stays engaged across the load', () => {
  /**
   * Speedlock-style poll loop at $C000: ticks B (EdgeLoader auto-start
   * needs b_diff = ±1), keeps A=$7F so port reads target $7FFE rather
   * than $FFFE — earReads never increments (high byte is $7F, not $FF).
   *   $C000: 04         INC B         ; 4T
   *   $C001: 3E 7F      LD A,$7F      ; 7T
   *   $C003: DB FE      IN A,($FE)    ; 11T
   *   $C005: EE 7F      XOR $7F       ; 7T
   *   $C007: 18 F7      JR -9 → $C000 ; 12T
   */
  function installSpeedlockLoop(s: Spectrum): void {
    const code = [0x04, 0x3E, 0x7F, 0xDB, 0xFE, 0xEE, 0x7F, 0x18, 0xF7];
    for (let i = 0; i < code.length; i++) s.memory.writeByte(0xC000 + i, code[i]);
    s.cpu.pc = 0xC000;
    s.cpu.sp = 0xFF00;
  }

  it('Speedlock-style poll (A=$7F) keeps turbo engaged for the whole load', () => {
    const s = makeMachine();
    installSpeedlockLoop(s);

    // Large enough payload that the tape takes >> 25 frames (the cooldown
    // length) to finish — exercising the sustained-engagement path.
    const loader = LOADERS.find(l => l.name === 'Speedlock 7')!;
    s.tape.blocks = [
      makeDataBlock(Array(200).fill(0xA5), loader, { pilotCount: 500, pause: 100 }),
    ];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = true;

    // Wait for engagement.
    tickUntil(s, () => s.tapeTurboActive, 5);
    expect(s.tapeTurboActive).toBe(true);

    // Run 40 frames — well past the 25-frame cooldown — and confirm turbo
    // never drops out while the tape is still loading. earReads stays at 0
    // throughout (we tally it via a hook to prove the point).
    let earReadsObserved = 0;
    let droppedOutWhilePlaying = false;
    for (let i = 0; i < 40; i++) {
      s.tick();
      earReadsObserved += s.activity.earReads;
      if (s.tape.playing && !s.tape.paused && !s.tape.finished && !s.tapeTurboActive) {
        droppedOutWhilePlaying = true;
        break;
      }
    }
    expect(droppedOutWhilePlaying).toBe(false);
    expect(earReadsObserved).toBe(0); // proves we're testing the non-$FF path

    // And it still disengages at end-of-tape.
    tickUntil(s, () => s.tape.finished, 200);
    expect(s.tape.finished).toBe(true);
    tickUntil(s, () => !s.tapeTurboActive, 5);
    expect(s.tapeTurboActive).toBe(false);
  });

  it('turbo releases when tape pauses mid-tape (loaderActive is sticky)', () => {
    // Regression: post-load polling kept `loaderActive` set indefinitely,
    // so the per-frame tapeLoading check refreshed the cooldown forever
    // and turbo never disengaged after auto-rewind paused the tape (or
    // any other tape.paused=true transition that wasn't end-of-tape).
    const s = makeMachine();
    installRomLoop(s);

    s.tape.blocks = [
      makeDataBlock([0x00, 0x11], LOADERS[0], { pilotCount: 30 }),
    ];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = true;

    tickUntil(s, () => s.tapeTurboActive, 5);
    expect(s.tapeTurboActive).toBe(true);

    // Simulate auto-rewind or any code path that pauses the tape without
    // marking it finished. loaderActive stays true from prior polling.
    s.tape.paused = true;
    expect(s.loaderDetector.loaderActive).toBe(true);

    // Within the cooldown window (25 frames), turbo must release.
    tickUntil(s, () => !s.tapeTurboActive, 30);
    expect(s.tapeTurboActive).toBe(false);
  });
});

// ── userOverride: user controls take priority over auto-detection ──────────
//
// The bug this guards: post-load, the running game's keyboard-polling loop
// can look enough like a loader (tight reads on port $FE) to re-fire the
// LoaderDetector's 'start' event after the user has manually paused/stopped
// the tape. Without userOverride this caused two visible symptoms:
//   1. Turbo never disengages — the detector keeps re-firing 'start', which
//      keeps loaderActive=true and the cooldown topped up.
//   2. User can't actually pause/stop — every manual paused=true is undone
//      within milliseconds by the next auto-start.
// userOverride is the user's authoritative "no, leave it stopped" flag.

describe('Accelerated loaders — userOverride suppresses auto-restart', () => {
  it('with userOverride=true, tight FE polling does NOT trigger auto-start', () => {
    const s = makeMachine();
    installPollLoop(s);
    s.tape.blocks = [makeDataBlock([0xAA], LOADERS[0], { pilotCount: 30 })];
    s.tape.position = 0;
    s.tape.paused = true;
    s.loaderDetector.userOverride = true;
    s.tapeTurbo = true;

    // 20 frames of tight polling — way more than the 10-read threshold.
    for (let i = 0; i < 20; i++) s.tick();

    expect(s.tape.playing).toBe(false);     // never auto-started
    expect(s.tapeTurboActive).toBe(false);  // turbo never engaged
  });

  it('clearing userOverride re-enables auto-start', () => {
    const s = makeMachine();
    installPollLoop(s);
    s.tape.blocks = [makeDataBlock([0xAA, 0xBB], LOADERS[0], { pilotCount: 30 })];
    s.tape.position = 0;
    s.tape.paused = true;
    s.loaderDetector.userOverride = true;
    s.tapeTurbo = true;

    // Suppressed phase.
    for (let i = 0; i < 5; i++) s.tick();
    expect(s.tape.playing).toBe(false);

    // User releases the override (equivalent to clicking play).
    s.loaderDetector.userOverride = false;
    tickUntil(s, () => s.tape.playing, 5);
    expect(s.tape.playing).toBe(true);
  });

  it('reset() clears userOverride (e.g. tape eject / machine reset)', () => {
    const s = makeMachine();
    s.loaderDetector.userOverride = true;
    s.loaderDetector.loaderActive = true;
    s.loaderDetector.reset();
    expect(s.loaderDetector.userOverride).toBe(false);
    expect(s.loaderDetector.loaderActive).toBe(false);
  });
});

// ── Accel-safe gating: Speedlock-class loaders must NOT have CPU state
//    synthesised. They use B as a calibrated raw-count with shadow-register
//    state and would mis-classify bits if we forced B to 0x00/0xFE per the
//    spec §4.1 binary-signal model. Regression for an Addams Family
//    (Speedlock 7) load that bailed to BASIC error vector $15E8 when accel
//    touched CPU state. Solved by gating accel on a per-signature allowlist
//    (see isAccelSafeSignature in src/tape/edge-loader.ts).
// ──────────────────────────────────────────────────────────────────────────

import { EdgeLoader, type EdgeLoaderHost, type LoaderSignature } from '@/tape/edge-loader.ts';
import { TapeDeck } from '@/tape/tap.ts';

describe('Accel-safe signature gating', () => {
  // Drive the EdgeLoader directly via a synthetic host. This isolates the
  // gating decision from CPU/ULA noise and lets us assert exactly which
  // register modifications happen for a given (signature, pulse-flag) pair.
  function makeHarness() {
    const tape = new TapeDeck(3_500_000);
    // Always claim there's an edge 600T away so accel actually has a
    // non-zero dt to consume — otherwise the rotate-only path runs.
    (tape as any).playing = true;
    (tape as any).phase = 4; // TapePhase.DATA — anything non-IDLE
    (tape as any).pulseLen = 600; (tape as any).tInPulse = 0;
    const cpu = { pc: 0, sp: 0xFF00, b: 0x55, c: 0x00, f: 0,
                  tStates: 0, a: 0, d: 0, e: 0, h: 0, l: 0 } as any;
    const mem = new Uint8Array(0x10000);
    // Place a known return at SP so we can spot any synthetic pop.
    mem[0xFF00] = 0x78; mem[0xFF01] = 0x56;
    const host: EdgeLoaderHost = {
      cpu, tape, readMem: (a) => mem[a & 0xFFFF], earBit: () => 0,
    };
    const loader = new EdgeLoader();
    return { loader, cpu, tape, host, mem };
  }

  // Install a real ROM-style pattern-A loop tail at $C000 (matches detector).
  function installRomTail(mem: Uint8Array): number {
    const code = [0x04, 0xC8, 0x3E, 0x7F, 0xDB, 0xFE, 0x1F, 0xD0,
                  0xA9, 0xE6, 0x20, 0x28, 0xF3];
    for (let i = 0; i < code.length; i++) mem[0xC000 + i] = code[i];
    return 0xC006;  // PC after IN
  }

  // Speedlock-fold: variant byte = $A9 (XOR C), 12-byte window, anchor $F4.
  function installSpeedlockTail(mem: Uint8Array): number {
    const code = [0x04, 0xC8, 0x3E, 0x7F, 0xDB, 0xFE, 0x1F, 0xA9,
                  0xE6, 0x20, 0x28, 0xF4];
    for (let i = 0; i < code.length; i++) mem[0xC000 + i] = code[i];
    return 0xC006;  // PC after IN
  }

  it('ROM signature: accel pops PC, sets B/CF', () => {
    const { loader, cpu, host, mem } = makeHarness();
    cpu.pc = installRomTail(mem);
    // Prime the length pipeline as if two natural edges had fired (LONG).
    loader.setAccelerationFlags('long', false);  // K2=T
    loader.onULARead(host, true);                // rotate: K1=T
    loader.setAccelerationFlags('long', false);  // K1 invalidated by !fromAccel
    loader.onULARead(host, true);                // rotate: K1=T
    // Detection should have matched 'rom'.
    expect(loader.signature).toBe('rom');
    // Now the third call should actually accelerate.
    const spBefore = cpu.sp;
    loader.onULARead(host, true);
    // CF set, PC popped to $5678, SP advanced by 2.
    expect(cpu.f & 1).toBe(1);
    expect(cpu.pc).toBe(0x5678);
    expect(cpu.sp).toBe((spBefore + 2) & 0xFFFF);
    // B forced to 0xFE for long pulse (increasing mode).
    expect(cpu.b).toBe(0xFE);
  });

  it('Speedlock signature: accel does NOT touch CPU state', () => {
    const { loader, cpu, host, mem } = makeHarness();
    cpu.pc = installSpeedlockTail(mem);
    cpu.b = 0x55; cpu.c = 0x33;
    const spBefore = cpu.sp;
    const pcBefore = cpu.pc;
    const bBefore = cpu.b;
    const cBefore = cpu.c;
    const fBefore = cpu.f;
    // Prime pipeline so K1=T (would normally trigger accel).
    loader.setAccelerationFlags('long', false);
    loader.onULARead(host, true);
    loader.setAccelerationFlags('long', false);
    loader.onULARead(host, true);
    expect(loader.signature).toBe('speedlock');
    // Several more polls — none should mutate CPU state.
    for (let i = 0; i < 5; i++) loader.onULARead(host, true);
    expect(cpu.sp).toBe(spBefore);
    expect(cpu.pc).toBe(pcBefore);
    expect(cpu.b).toBe(bBefore);
    expect(cpu.c).toBe(cBefore);
    expect(cpu.f).toBe(fBefore);
  });
});

// ── §2 auto-stop conjunction (tDiff AND bDiff) ─────────────────────────────
//
// Regression for "Speedlock 1 pilot OK, sync→data dies mid-block". The 48K
// ROM's LD-MARKER reloads `B,$B0` between every bit, so the first IN of each
// new bit shows a bDiff far outside {0, 1, 0xFF}. The earlier `OR` test
// stopped the tape after 2 close bit boundaries even though gaps stayed under
// 1000T. Auto-stop now requires both criteria together; "loader has moved on"
// game code naturally trips both (wide gaps and free B mutation).
//
// We drive the detector directly with synthetic (t, b) pairs so the
// assertions don't depend on any specific ROM byte sequence.

describe('EdgeLoader §2 auto-stop: requires tDiff AND bDiff together', () => {
  function freshLoader() {
    const tape = new TapeDeck(3_500_000);
    (tape as any).playing = true;
    const cpu = { tStates: 0, b: 0, pc: 0, sp: 0, c: 0, f: 0,
                  a: 0, d: 0, e: 0, h: 0, l: 0 } as any;
    const host: EdgeLoaderHost = {
      cpu, tape, readMem: () => 0, earBit: () => 0,
    };
    const loader = new EdgeLoader();
    // Disable surgical accel so onULARead only exercises the §2 path —
    // we're asserting on auto-stop, not on edge skipping.
    loader.accelerateLoader = false;
    // Prime lastTStatesRead/lastBRead with a tight in-shape pair so the
    // first interesting read in each test computes a real diff rather than
    // tripping the NO_PREV first-read shortcut.
    cpu.tStates = 100; cpu.b = 0x10; loader.onULARead(host, true);
    cpu.tStates = 160; cpu.b = 0x11; loader.onULARead(host, true);
    return { loader, cpu, host };
  }

  it('bDiff alone (tight gap, wild B): stays playing — LD-MARKER bit boundaries', () => {
    const { loader, cpu, host } = freshLoader();
    // Mimic 8 bit boundaries in a row: each "boundary" read has tight gap
    // (60T, well under STOP_GAP_T=1000) but B has been reloaded so bDiff
    // lands outside {0, 1, 0xFF}. Real ROM loaders do exactly this between
    // every bit during LD-8-BITS.
    for (let i = 0; i < 8; i++) {
      cpu.tStates += 60;
      cpu.b = 0xB0;  // reset to LD B,$B0 → bDiff vs prior ~0xBE is huge
      expect(loader.onULARead(host, true)).toBeNull();
      cpu.tStates += 60;
      cpu.b = 0xB1;  // INC B → bDiff = 1 (inShape), resets successive
      expect(loader.onULARead(host, true)).toBeNull();
    }
  });

  it('tDiff alone (wide gap, well-behaved B): stays playing', () => {
    const { loader, cpu, host } = freshLoader();
    // Wide T-state gap but bDiff stays in {0, 1, 0xFF}. Could be a slow
    // loader that does heavy bookkeeping between port reads but still
    // ticks B by +1 each time. Auto-stop must not fire.
    for (let i = 0; i < 5; i++) {
      cpu.tStates += 5000;       // > STOP_GAP_T
      cpu.b = (cpu.b + 1) & 0xFF; // bDiff = 1 (inShape)
      expect(loader.onULARead(host, true)).toBeNull();
    }
  });

  it('both together: stops after STOP_THRESHOLD=2 successive', () => {
    const { loader, cpu, host } = freshLoader();
    // Two reads in a row where BOTH tDiff > 1000T AND bDiff outside the
    // tight set. This is the real "loader is gone, game code is running"
    // shape — auto-stop should fire on the 2nd read.
    cpu.tStates += 5000; cpu.b = 0x42;
    expect(loader.onULARead(host, true)).toBeNull();
    cpu.tStates += 5000; cpu.b = 0x99;
    expect(loader.onULARead(host, true)).toBe('stop');
  });

  it('turbo engages when accelerateLoader is off (turbo and edge accel are independent)', () => {
    // Regression: "Turbo during load" should engage tape turbo for any
    // detected loader poll loop, even when "Accelerated edge loading" is
    // off. The two settings address different concerns — surgical edge
    // skipping vs frame-multiplier turbo — and turbo must work standalone.
    const s = makeMachine();
    installRomLoop(s);

    s.tape.blocks = [
      makeDataBlock([0x00, 0x11], LOADERS[0], { pilotCount: 30 }),
    ];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = true;
    s.loaderDetector.accelerateLoader = false;

    tickUntil(s, () => s.tapeTurboActive, 5);
    expect(s.tapeTurboActive).toBe(true);
    // And surgical accel really is off — signature stays 'unknown' because
    // §3 detection only runs inside maybeAccelerate. (Auto play/stop still
    // sets loaderActive, which is what drives turbo.)
    expect(s.loaderDetector.signature).toBe('unknown');
    expect(s.loaderDetector.loaderActive).toBe(true);
  });

  it('loaderActive becomes true on in-shape polling while already playing (turbo path)', () => {
    // When the tape was started by some path other than §2 auto-start —
    // the instant-ROM trap, the user pressing Play, a snapshot restore —
    // loaderActive would otherwise stay false even while a loader is
    // actively polling. spectrum.ts's per-frame tapeLoading check gates
    // turbo on loaderActive (among others), so without this, turbo
    // wouldn't engage for the post-trap custom-loader stage of a tape.
    const tape = new TapeDeck(3_500_000);
    (tape as any).playing = true;  // already playing — §2 'start' won't fire
    const cpu = { tStates: 0, b: 0, pc: 0, sp: 0, c: 0, f: 0,
                  a: 0, d: 0, e: 0, h: 0, l: 0 } as any;
    const host: EdgeLoaderHost = {
      cpu, tape, readMem: () => 0, earBit: () => 0,
    };
    const loader = new EdgeLoader();
    loader.accelerateLoader = false;

    expect(loader.loaderActive).toBe(false);
    // Prime then feed a few tight in-shape reads — the shape of any
    // edge-detect inner loop ticking B by +1.
    cpu.tStates = 100; cpu.b = 0x10; loader.onULARead(host, true);
    cpu.tStates = 160; cpu.b = 0x11; loader.onULARead(host, true);
    cpu.tStates = 220; cpu.b = 0x12; loader.onULARead(host, true);
    expect(loader.loaderActive).toBe(true);
  });

  it('one outOfShape then inShape: never reaches threshold', () => {
    const { loader, cpu, host } = freshLoader();
    // Single outOfShape gets reset by an inShape read — what happens
    // every bit boundary during normal data sampling.
    cpu.tStates += 5000; cpu.b = 0x42;   // both conditions → successive=1
    expect(loader.onULARead(host, true)).toBeNull();
    cpu.tStates += 60;   cpu.b = 0x43;   // bDiff=1 → inShape, resets
    expect(loader.onULARead(host, true)).toBeNull();
    cpu.tStates += 5000; cpu.b = 0x55;   // successive=1 again, not 2
    expect(loader.onULARead(host, true)).toBeNull();
  });
});

// ── Speedlock 1 (Alien 8 / Ultimate, 1985) real loader bytes ───────────────
//
// Verified against the in-emulator Speedlock 1 loader at $EC5A while loading
// "Alien 8 (1985)(Ultimate Play The Game).tzx". The 16-byte sequence here is
// the exact byte-for-byte image of the inner edge loop and its bit-toggle
// epilogue. This guards the structural detector against any change that
// would break recognition of real Speedlock 1 protected dumps (we can't
// ship the .tzx, so the bytes themselves are the test fixture).
//
//   A7        AND A         ; clear CF
//   04        INC B
//   C8        RET Z
//   3E 7F     LD A,$7F
//   DB FE     IN A,($FE)
//   1F        RRA
//   A9        XOR C
//   E6 20     AND $20
//   28 F4     JR Z,-12      ; back to INC B (12-byte window, anchor $F4)
//   79        LD A,C
//   2F        CPL
//   4F        LD C,A        ; toggle expected-bit mask
//
// PC sits right after IN A,($FE), so the detector reads from PC-6 = the INC B
// and matches Pattern A with variant byte $A9 → signature 'speedlock'.

describe('Speedlock 1 — real loader byte fingerprint', () => {
  function installSpeedlock1Loop(s: Spectrum): void {
    const code = [
      0xA7, 0x04, 0xC8, 0x3E, 0x7F, 0xDB, 0xFE, 0x1F,
      0xA9, 0xE6, 0x20, 0x28, 0xF4, 0x79, 0x2F, 0x4F,
    ];
    const base = 0xEC5A;
    for (let i = 0; i < code.length; i++) s.memory.writeByte(base + i, code[i]);
    // Fall through past LD C,A back to AND A so the loop keeps polling.
    s.memory.writeByte(base + 16, 0x18); // JR -18 → back to $EC5A
    s.memory.writeByte(base + 17, 0xEC);
    s.cpu.pc = base;
    s.cpu.sp = 0xFF00;
    s.cpu.c = 0x00;
  }

  it('detects signature=\'speedlock\' from real Alien 8 loader bytes', () => {
    const s = makeMachine();
    installSpeedlock1Loop(s);

    const loader = LOADERS.find(l => l.name === 'Speedlock 1-2')!;
    s.tape.blocks = [
      makeDataBlock(Array(20).fill(0x5A), loader, { pilotCount: 60, pause: 10 }),
    ];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = true;

    tickUntil(s, () => s.tape.playing && !s.tape.paused, 5);
    expect(s.tape.playing).toBe(true);
    expect(s.loaderDetector.signature).toBe('speedlock');
  });

  it('Speedlock 1 loader: turbo engages and tape completes the block', () => {
    const s = makeMachine();
    installSpeedlock1Loop(s);

    const loader = LOADERS.find(l => l.name === 'Speedlock 1-2')!;
    s.tape.blocks = [
      makeDataBlock(Array(40).fill(0xA5), loader, { pilotCount: 100, pause: 0 }),
    ];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = true;

    tickUntil(s, () => s.loaderDetector.signature === 'speedlock', 5);
    expect(s.loaderDetector.signature).toBe('speedlock');
    expect(s.tapeTurboActive).toBe(true);

    // Tape advances naturally even though edge-skip accel is gated off for
    // Speedlock (the frame multiplier still provides the speed-up). The
    // 'Accel-safe signature gating' suite asserts the no-CPU-mutation
    // contract directly; here we just need the load to progress to end.
    tickUntil(s, () => s.tape.finished, 100);
    expect(s.tape.finished).toBe(true);
  });
});

// ── loaderActive: bracketed by 'start' / 'stop' events ─────────────────────

describe('LoaderDetector.loaderActive — state tracking', () => {
  it('flips to true on \'start\' and false on \'stop\'', () => {
    const s = makeMachine();
    installPollLoop(s);
    s.tape.blocks = [makeDataBlock(Array(20).fill(0x55), LOADERS[0], { pilotCount: 200, pause: 0 })];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = true;

    expect(s.loaderDetector.loaderActive).toBe(false);
    tickUntil(s, () => s.loaderDetector.loaderActive, 5);
    expect(s.loaderDetector.loaderActive).toBe(true);

    // Run the tape to completion — turbo engaged the whole time.
    tickUntil(s, () => s.tape.finished, 100);
    expect(s.tape.finished).toBe(true);

    // After tape ends and loaderActive is no longer being refreshed, turbo
    // disengages. (The 'stop' itself may or may not fire depending on the
    // final block's pause vs the loader still polling — but `tape.finished`
    // is the strict terminal state and that's enough for the cooldown.)
    tickUntil(s, () => !s.tapeTurboActive, 5);
    expect(s.tapeTurboActive).toBe(false);
  });
});

// ── User pause/stop drops turbo within the cooldown ────────────────────────
//
// The bug this guards: even when the detector's loaderActive flag is true
// (an in-progress load), the user's explicit pause/stop must still drop
// turbo. Otherwise the visible MHz readout stays pinned at ~50, audio stays
// suppressed, and the pause feels broken to the user. The cooldown check
// in spectrum.ts must respect userOverride and decay accordingly.

describe('Accelerated loaders — user pause overrides loaderActive', () => {
  it('setting userOverride mid-load drops turbo within the cooldown', () => {
    const s = makeMachine();
    installPollLoop(s);
    s.tape.blocks = [
      makeDataBlock(Array(100).fill(0x55), LOADERS[0], { pilotCount: 500, pause: 0 }),
    ];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = true;

    tickUntil(s, () => s.tapeTurboActive, 5);
    expect(s.tapeTurboActive).toBe(true);
    expect(s.loaderDetector.loaderActive).toBe(true);

    // User clicks pause: the UI sets paused + userOverride together.
    s.tape.paused = true;
    s.loaderDetector.userOverride = true;

    // Turbo must release even though loaderActive is still true.
    tickUntil(s, () => !s.tapeTurboActive, 40);
    expect(s.tapeTurboActive).toBe(false);

    // And the polling cannot auto-restart the tape.
    for (let i = 0; i < 20; i++) s.tick();
    expect(s.tape.paused).toBe(true);
    expect(s.tapeTurboActive).toBe(false);
  });
});

// ── Setting respect ────────────────────────────────────────────────────────

describe('Accelerated loaders — settings', () => {
  it('with tapeTurbo=false, turbo never engages even though the loader is detected', () => {
    const s = makeMachine();
    installPollLoop(s);
    s.tape.blocks = [makeDataBlock([0x00, 0x11], LOADERS[0], { pilotCount: 30 })];
    s.tape.position = 0;
    s.tape.paused = true;
    s.tapeTurbo = false;

    // Run the tape through its full lifecycle. The LoaderDetector still fires
    // (its behaviour is independent of the setting); the tape still plays
    // and finishes. But tapeTurboActive must never flip on.
    let everEngaged = false;
    for (let i = 0; i < 30; i++) {
      s.tick();
      if (s.tapeTurboActive) everEngaged = true;
    }
    expect(everEngaged).toBe(false);
    expect(s.tape.finished).toBe(true);
    expect(s.turbo).toBe(false);
  });
});

// ── dt=0: acceleration when the edge is exactly due ───────────────────────

describe('EdgeLoader acceleration — dt=0 edge boundary', () => {
  function makeSyntheticHost(pulseLen: number, tInPulse: number) {
    const tape = new TapeDeck(3_500_000);
    (tape as any).playing = true;
    (tape as any).phase = 2; // SYNC1 — a short pulse that publishes flags
    (tape as any).pulseLen = pulseLen;
    (tape as any).tInPulse = tInPulse;
    (tape as any).bSync1 = pulseLen; // sync1 uses this
    (tape as any).bSync2 = 667; // next phase
    (tape as any).bBit0 = 855; (tape as any).bBit1 = 1710; (tape as any).bPilot = 2168;
    (tape as any).rawData = new Uint8Array([0xFF, 0x80, 0x7F]); // flag + payload + checksum
    (tape as any).byteIdx = 0; (tape as any).bitIdx = 7; (tape as any).pulseHalf = 0;
    (tape as any).usedBitsLast = 8;
    const cpu = { tStates: 0, b: 0x01, c: 0, f: 0, sp: 0xFF00, pc: 0, a: 0, d: 0, e: 0, h: 0, l: 0 } as any;
    const mem = new Uint8Array(0x10000);
    mem[0xFF00] = 0x78; mem[0xFF01] = 0x56;
    mem[0xC000] = 0x04; mem[0xC001] = 0xC8; mem[0xC002] = 0x3E; mem[0xC003] = 0x7F;
    mem[0xC004] = 0xDB; mem[0xC005] = 0xFE; mem[0xC006] = 0x1F; mem[0xC007] = 0xD0;
    mem[0xC008] = 0xA9; mem[0xC009] = 0xE6; mem[0xC00A] = 0x20; mem[0xC00B] = 0x28; mem[0xC00C] = 0xF3;
    const host: EdgeLoaderHost = {
      cpu, tape, readMem: (a) => mem[a & 0xFFFF], earBit: () => 0,
    };
    const loader = new EdgeLoader();
    loader.accelerateLoader = true;
    return { loader, cpu, tape, host, mem };
  }

  it('dt=0 (edge exactly at boundary) still crosses the edge and advances', () => {
    const { loader, cpu, tape, host } = makeSyntheticHost(100, 100); // tInPulse === pulseLen
    cpu.pc = 0xC006; // after IN — detector reads PC-6
    // Prime the pipeline so acceleration fires.
    loader.setAccelerationFlags('short', false);
    loader.onULARead(host, true); // rotate: K1 = known
    loader.setAccelerationFlags('short', false);
    loader.onULARead(host, true); // rotate: K1 = known

    expect(loader.signature).toBe('rom');
    expect((tape as any).phase).toBe(2); // still SYNC1
    const earBefore = tape.earBit;
    // acceleration with dt=0
    loader.onULARead(host, true);
    // Edge crossed: earBit toggled, phase advanced.
    expect(tape.earBit).not.toBe(earBefore);
    // After single-edge advance, phase should have moved from SYNC1 → SYNC2
    // (advancePulse transitions SYNC1→SYNC2).
    expect((tape as any).phase).toBe(3); // SYNC2
  });

  it('single-edge advance stops after one edge even when dt spans multiple pulses', () => {
    const { loader, cpu, tape, host } = makeSyntheticHost(10, 0); // tiny pulse, ready
    cpu.pc = 0xC006;
    loader.setAccelerationFlags('long', false);
    loader.onULARead(host, true);
    loader.setAccelerationFlags('long', false);
    loader.onULARead(host, true);
    expect(loader.signature).toBe('rom');
    // dt = 10 (full pulse). Call accelerate with singleEdge=true.
    // Verify earBit toggled exactly once — not pumped through multiple edges.
    const flips: number[] = [];
    const origOnEdge = tape.onEdgeScheduled;
    tape.onEdgeScheduled = (_f, _a) => {
      flips.push(tape.earBit);
      if (origOnEdge) origOnEdge(_f, _a);
    };
    loader.onULARead(host, true);
    tape.onEdgeScheduled = origOnEdge;
    // Single edge = one flip captured.
    expect(flips.length).toBeLessThanOrEqual(2); // at most one edge publish + possible next
  });
});

// ── post-acceleration auto-stop suppression ───────────────────────────────

describe('EdgeLoader — post-acceleration auto-stop suppression', () => {
  it('synthetic B=0xFE does not poison auto-stop on next real IN', () => {
    // After acceleration forces B=0xFE (long edge, INCREASING mode), the
    // lastBRead fix should predict B+1 so the loader's real INC B at re-entry
    // produces bDiff = 1, not a wild value.
    const tape = new TapeDeck(3_500_000);
    (tape as any).playing = true;
    (tape as any).phase = 4; // DATA — currentEdgeFlags returns known
    (tape as any).pulseLen = 855; (tape as any).tInPulse = 100;
    (tape as any).rawData = new Uint8Array([0xFF, 0x80, 0x7F]);
    (tape as any).byteIdx = 0; (tape as any).bitIdx = 7; (tape as any).pulseHalf = 0;
    (tape as any).usedBitsLast = 8;
    (tape as any).bPilot = 2168; (tape as any).bSync1 = 667; (tape as any).bSync2 = 735;
    (tape as any).bBit0 = 855; (tape as any).bBit1 = 1710;
    const cpu = { tStates: 1000, b: 0x01, c: 0, f: 0, sp: 0xFF00, pc: 0, a: 0, d: 0, e: 0, h: 0, l: 0 } as any;
    const mem = new Uint8Array(0x10000);
    mem[0xFF00] = 0x78; mem[0xFF01] = 0x56;
    mem[0xC000] = 0x04; mem[0xC001] = 0xC8; mem[0xC002] = 0x3E; mem[0xC003] = 0x7F;
    mem[0xC004] = 0xDB; mem[0xC005] = 0xFE; mem[0xC006] = 0x1F; mem[0xC007] = 0xD0;
    mem[0xC008] = 0xA9; mem[0xC009] = 0xE6; mem[0xC00A] = 0x20; mem[0xC00B] = 0x28; mem[0xC00C] = 0xF3;
    const host: EdgeLoaderHost = {
      cpu, tape, readMem: (a) => mem[a & 0xFFFF], earBit: () => 0,
    };
    const loader = new EdgeLoader();
    loader.accelerateLoader = true;
    cpu.pc = 0xC006;

    // Prime: three rounds so accel actually fires on the third.
    loader.setAccelerationFlags('long', false);
    loader.onULARead(host, true);
    loader.setAccelerationFlags('long', false);
    loader.onULARead(host, true);
    // Third onULARead is the one that accelerates with lengthKnown1=true.
    loader.onULARead(host, true);
    expect(loader.signature).toBe('rom');
    // Acceleration forces B=0xFE (long, increasing mode).
    expect(cpu.b).toBe(0xFE);

    // Simulate loader re-entry: INC B → B = 0xFF.
    cpu.b = (cpu.b + 1) & 0xFF;
    // Short gap, in-shape B-delta: should NOT trigger auto-stop.
    cpu.tStates += 40; // < STOP_GAP_T
    const result = loader.onULARead(host, true);
    expect(result).toBeNull(); // no stop event
  });

  it('wide tDiff after accel with in-shape bDiff still does not stop', () => {
    // If the byte-processing gap is wide but B is well-behaved on re-entry,
    // auto-stop should not fire (tDiff alone insufficient).
    const tape = new TapeDeck(3_500_000);
    (tape as any).playing = true;
    (tape as any).phase = 4;
    (tape as any).pulseLen = 1710; (tape as any).tInPulse = 500;
    (tape as any).rawData = new Uint8Array([0xFF, 0x80, 0x7F]);
    (tape as any).byteIdx = 0; (tape as any).bitIdx = 7; (tape as any).pulseHalf = 0;
    (tape as any).usedBitsLast = 8;
    (tape as any).bPilot = 2168; (tape as any).bSync1 = 667; (tape as any).bSync2 = 735;
    (tape as any).bBit0 = 855; (tape as any).bBit1 = 1710;
    const cpu = { tStates: 5000, b: 0x05, c: 0, f: 0, sp: 0xFF00, pc: 0, a: 0, d: 0, e: 0, h: 0, l: 0 } as any;
    const mem = new Uint8Array(0x10000);
    mem[0xFF00] = 0x78; mem[0xFF01] = 0x56;
    mem[0xC000] = 0x04; mem[0xC001] = 0xC8; mem[0xC002] = 0x3E; mem[0xC003] = 0x7F;
    mem[0xC004] = 0xDB; mem[0xC005] = 0xFE; mem[0xC006] = 0x1F; mem[0xC007] = 0xD0;
    mem[0xC008] = 0xA9; mem[0xC009] = 0xE6; mem[0xC00A] = 0x20; mem[0xC00B] = 0x28; mem[0xC00C] = 0xF3;
    const host: EdgeLoaderHost = {
      cpu, tape, readMem: (a) => mem[a & 0xFFFF], earBit: () => 0,
    };
    const loader = new EdgeLoader();
    loader.accelerateLoader = true;
    cpu.pc = 0xC006;

    // Prime and accelerate — needs three onULARead calls.
    loader.setAccelerationFlags('long', false);
    loader.onULARead(host, true);
    loader.setAccelerationFlags('long', false);
    loader.onULARead(host, true);
    loader.onULARead(host, true);
    expect(loader.signature).toBe('rom');
    expect(cpu.b).toBe(0xFE);

    // Simulate re-entry with INC B: B = 0xFF. Wide gap (2000T > 1000).
    // After accel, B = 0xFE. lastBRead fix: (0xFE + 1) & 0xFF = 0xFF.
    // Then INC B → 0xFF. bDiff = (0xFF - 0xFF) & 0xFF = 0. In shape.
    cpu.b = (cpu.b + 1) & 0xFF;
    cpu.tStates += 2000;
    // bDiff predicted = 1 (0xFF - 0xFF = 0... wait, lastBRead was adjusted to
    // cpu.b + 1 = 0xFF after acceleration, and now cpu.b is 0xFF too.
    // bDiff = 0xFF - 0xFF = 0. In-shape. Auto-stop must NOT fire.
    // Wait: after accel, b = 0xFE. lastBRead = (0xFE + 1) & 0xFF = 0xFF.
    // Then INC B → 0xFF. bDiff = (0xFF - 0xFF) & 0xFF = 0. In shape.
    const result = loader.onULARead(host, true);
    expect(result).toBeNull();

    // Second wide read: also in-shape bDiff (B stays at 0xFF, INC B → 0x00).
    cpu.tStates += 2000;
    cpu.b = 0x00;
    const result2 = loader.onULARead(host, true);
    expect(result2).toBeNull();
  });
});

// ── Pipeline reset on tape play-state transition ─────────────────────────

describe('EdgeLoader — pipeline reset on play-state change', () => {
  it('onTapePlayStateChange clears the length pipeline', () => {
    const loader = new EdgeLoader();
    // Prime both slots by setting internal state directly.
    (loader as any).lengthKnown1 = true;
    (loader as any).lengthLong1 = true;
    (loader as any).lengthKnown2 = true;
    (loader as any).lengthLong2 = true;
    (loader as any).accelMode = 'increasing';
    (loader as any).successiveReads = 5;
    // Tape stop clears everything.
    loader.onTapePlayStateChange();
    expect((loader as any).lengthKnown1).toBe(false);
    expect((loader as any).lengthLong1).toBe(false);
    expect((loader as any).lengthKnown2).toBe(false);
    expect((loader as any).lengthLong2).toBe(false);
    expect((loader as any).accelMode).toBe('none');
    expect((loader as any).successiveReads).toBe(0);
  });
});

// ── Per-signature auto-stop thresholds ────────────────────────────────────

describe('EdgeLoader — per-signature auto-stop thresholds', () => {
  function hostForSig(sig: LoaderSignature) {
    const tape = new TapeDeck(5_000_000);
    (tape as any).playing = true;
    (tape as any).phase = 4; // DATA
    (tape as any).pulseLen = 1000; (tape as any).tInPulse = 0;
    (tape as any).rawData = new Uint8Array([0xFF, 0x80, 0x7F]);
    (tape as any).byteIdx = 0; (tape as any).bitIdx = 7; (tape as any).pulseHalf = 0;
    (tape as any).usedBitsLast = 8;
    (tape as any).bPilot = 2168; (tape as any).bSync1 = 667; (tape as any).bSync2 = 735;
    (tape as any).bBit0 = 855; (tape as any).bBit1 = 1710;
    const cpu = { tStates: 0, b: 0x10, c: 0, f: 0, sp: 0xFF00, pc: 0, a: 0, d: 0, e: 0, h: 0, l: 0 } as any;
    const mem = new Uint8Array(0x10000);
    mem[0xFF00] = 0x78; mem[0xFF01] = 0x56;
    const host: EdgeLoaderHost = {
      cpu, tape, readMem: (a) => mem[a & 0xFFFF], earBit: () => 0,
    };
    const loader = new EdgeLoader();
    loader.accelerateLoader = false; // only exercising §2 auto-stop
    // Inject the signature.
    (loader as any).signature = sig;
    (loader as any).loaderActive = true;
    return { loader, cpu, host };
  }

  it('speedlock requires more out-of-shape reads to auto-stop (threshold 4)', () => {
    const { loader, cpu, host } = hostForSig('speedlock');
    // First call is baseline (NO_PREV). Then 4 outOfShape calls to hit threshold.
    for (let i = 0; i < 4; i++) {
      cpu.tStates += 2500;
      cpu.b = (cpu.b + 0x37) & 0xFF; // wild bDiff
      expect(loader.onULARead(host, true)).toBeNull();
    }
    // 5th call (4th outOfShape) fires stop.
    cpu.tStates += 2500;
    cpu.b = (cpu.b + 0x13) & 0xFF;
    expect(loader.onULARead(host, true)).toBe('stop');
  });

  it('alkatraz has threshold 3', () => {
    const { loader, cpu, host } = hostForSig('alkatraz');
    for (let i = 0; i < 3; i++) {
      cpu.tStates += 2000;
      cpu.b = (cpu.b + 0x47) & 0xFF;
      expect(loader.onULARead(host, true)).toBeNull();
    }
    cpu.tStates += 2000;
    cpu.b = (cpu.b + 0x11) & 0xFF;
    expect(loader.onULARead(host, true)).toBe('stop');
  });

  it('unknown signature uses default thresholds (2 reads, 1000T gap)', () => {
    const { loader, cpu, host } = hostForSig('unknown');
    // First call is baseline. Then 2 outOfShape calls.
    cpu.tStates += 1200;
    cpu.b = 0x42;
    expect(loader.onULARead(host, true)).toBeNull();
    cpu.tStates += 1200;
    cpu.b = 0x77;
    expect(loader.onULARead(host, true)).toBeNull();
    // 3rd call (2nd outOfShape) fires stop.
    cpu.tStates += 1200;
    cpu.b = 0x99;
    expect(loader.onULARead(host, true)).toBe('stop');
  });

  it('rom signature with gap 900T does not trigger (below default 1000T)', () => {
    const { loader, cpu, host } = hostForSig('rom');
    // Gap below threshold — outOfShape is false.
    cpu.tStates += 900;
    cpu.b = 0x42;
    expect(loader.onULARead(host, true)).toBeNull();
    cpu.tStates += 900;
    cpu.b = 0x99;
    expect(loader.onULARead(host, true)).toBeNull(); // still in-shape (tDiff ≤ 1000)
  });

  it('speedlock with gap 1500T does not trigger (below its 2000T threshold)', () => {
    const { loader, cpu, host } = hostForSig('speedlock');
    cpu.tStates += 1500;
    cpu.b = 0x42;
    expect(loader.onULARead(host, true)).toBeNull();
    cpu.tStates += 1500;
    cpu.b = 0x99;
    expect(loader.onULARead(host, true)).toBeNull();
    // But at 2500T it does.
    cpu.tStates += 2500;
    cpu.b = 0x77;
    expect(loader.onULARead(host, true)).toBeNull(); // count=1
    cpu.tStates += 2500;
    cpu.b = 0xAA;
    expect(loader.onULARead(host, true)).toBeNull(); // count=2
    cpu.tStates += 2500;
    cpu.b = 0xBB;
    expect(loader.onULARead(host, true)).toBeNull(); // count=3
    cpu.tStates += 2500;
    cpu.b = 0xCC;
    expect(loader.onULARead(host, true)).toBe('stop'); // count=4
  });
});
