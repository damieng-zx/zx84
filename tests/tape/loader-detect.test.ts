/**
 * loader-detect.ts — port-0xFE edge-detection-loop watcher.
 *
 * The detector returns 'start' / 'stop' / null and never touches the tape
 * itself, so tests can drive it deterministically with synthetic port-read
 * sequences. We cover:
 *
 *   - Auto-start trigger (10 reads, tight gap + B-delta in {0, ±1})
 *   - Auto-start non-trigger when the pattern breaks (gap, delta, both)
 *   - Counter reset on any non-matching read (no leak across patterns)
 *   - Auto-stop trigger (2 reads with gap > STOP_GAP OR loose B-delta)
 *   - Auto-stop hysteresis vs occasional CPU stalls inside the loader
 *   - Frame-boundary T-state adjustment keeps gaps correct
 *   - reset() clears all state including the previous-read sentinel
 *   - Sentinel: the very first read after construction never starts
 *
 * Threshold values are deliberately hardcoded in the asserts — if anyone
 * tweaks them, these tests should be the failure surface, not surprises
 * in real loaders.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LoaderDetector } from '@/tape/loader-detect.ts';

let det: LoaderDetector;
beforeEach(() => { det = new LoaderDetector(); });

// ── Auto-start ──────────────────────────────────────────────────────────

describe('LoaderDetector — auto-start', () => {
  it('first read after construction never fires (no previous read to compare to)', () => {
    expect(det.onPortRead(1000, 0, false)).toBeNull();
  });

  it('triggers after exactly 10 successive matching reads', () => {
    let t = 1000;
    let b = 0;
    // First read primes the previous-T sentinel; it's never a "match" itself.
    expect(det.onPortRead(t, b, false)).toBeNull();
    // 10 more matching reads — last one fires
    for (let i = 0; i < 9; i++) {
      t += 100; b += 1;
      expect(det.onPortRead(t, b, false)).toBeNull();
    }
    t += 100; b += 1;
    expect(det.onPortRead(t, b, false)).toBe('start');
  });

  it('accepts B-delta of 0 and -1, not just +1', () => {
    let t = 1000;
    det.onPortRead(t, 5, false); // prime
    for (let i = 0; i < 9; i++) {
      t += 50;
      // Alternating delta pattern: 0, -1, 0, -1, ...
      const b = i % 2 === 0 ? 5 : 4;
      expect(det.onPortRead(t, b, false)).toBeNull();
    }
    t += 50;
    expect(det.onPortRead(t, 4, false)).toBe('start');
  });

  it('resets the counter when gap exceeds START_GAP (500T)', () => {
    let t = 0;
    det.onPortRead(t, 0, false);
    // 9 matching reads — one short of trigger
    for (let i = 0; i < 9; i++) {
      t += 100;
      expect(det.onPortRead(t, i + 1, false)).toBeNull();
    }
    // Break the pattern: gap of 600T (>500)
    t += 600;
    expect(det.onPortRead(t, 10, false)).toBeNull(); // counter reset
    // Now need 10 more matching reads to reach threshold again
    for (let i = 0; i < 9; i++) {
      t += 100;
      expect(det.onPortRead(t, 11 + i, false)).toBeNull();
    }
    t += 100;
    expect(det.onPortRead(t, 20, false)).toBe('start');
  });

  it('resets the counter when B-delta is outside {-1, 0, +1}', () => {
    let t = 0;
    let b = 0;
    det.onPortRead(t, b, false);
    for (let i = 0; i < 9; i++) {
      t += 100; b += 1;
      expect(det.onPortRead(t, b, false)).toBeNull();
    }
    // Break: B jumps by 5 (typical keyboard-scan signature)
    t += 100; b += 5;
    expect(det.onPortRead(t, b, false)).toBeNull(); // reset
    // Need a full 10-read sequence to re-trigger
    for (let i = 0; i < 9; i++) {
      t += 100; b += 1;
      expect(det.onPortRead(t, b, false)).toBeNull();
    }
    t += 100; b += 1;
    expect(det.onPortRead(t, b, false)).toBe('start');
  });

  it('gap exactly at 500T still counts as tight (inclusive boundary)', () => {
    let t = 0;
    det.onPortRead(t, 0, false);
    for (let i = 0; i < 10; i++) {
      t += 500;
      const ev = det.onPortRead(t, i + 1, false);
      if (i < 9) expect(ev).toBeNull();
      else expect(ev).toBe('start');
    }
  });

  it('gap of 501T resets — exclusive on the >', () => {
    let t = 0;
    det.onPortRead(t, 0, false);
    for (let i = 0; i < 9; i++) {
      t += 501;
      expect(det.onPortRead(t, i + 1, false)).toBeNull();
    }
    t += 501;
    // No start: every single read was over budget so the counter never built
    expect(det.onPortRead(t, 10, false)).toBeNull();
  });
});

// ── Auto-stop ───────────────────────────────────────────────────────────

describe('LoaderDetector — auto-stop', () => {
  // Helper: get the detector into the playing-state with a settled prior read.
  function primePlaying(t0 = 1000, b0 = 0) {
    det.onPortRead(t0, b0, true);
  }

  it('first non-matching read while playing does NOT stop (hysteresis = 2)', () => {
    primePlaying();
    // Gap of 2000T — well over STOP_GAP (1000)
    expect(det.onPortRead(3000, 0, true)).toBeNull();
  });

  it('two successive non-matching reads while playing fire stop', () => {
    primePlaying();
    expect(det.onPortRead(3000, 0, true)).toBeNull(); // over gap
    expect(det.onPortRead(5000, 0, true)).toBe('stop'); // over gap again
  });

  it('B-delta outside {-1, 0, +1} while playing counts as non-matching', () => {
    primePlaying(1000, 10);
    // Tight gap but B jumps by 7 — typical for the loader exiting into post-load
    expect(det.onPortRead(1100, 17, true)).toBeNull();
    expect(det.onPortRead(1200, 24, true)).toBe('stop');
  });

  it('a matching read between two off-pattern reads resets the stop counter', () => {
    primePlaying();
    expect(det.onPortRead(3000, 0, true)).toBeNull(); // over gap → 1
    // Back into the loader pattern for one read
    expect(det.onPortRead(3100, 1, true)).toBeNull(); // tight + delta=1 → reset
    // Now one more off-pattern read — should NOT fire stop yet
    expect(det.onPortRead(5000, 1, true)).toBeNull();
  });

  it('STOP_GAP (1000T) is exclusive: gap of exactly 1000T is still matching', () => {
    primePlaying();
    // Two reads at exactly 1000T apart, B-delta=1 — both should be matching
    expect(det.onPortRead(2000, 1, true)).toBeNull();
    expect(det.onPortRead(3000, 2, true)).toBeNull();
  });

  it('does NOT fire stop when not playing (only listens for start in that state)', () => {
    det.onPortRead(1000, 0, false);
    // A wide gap while not-playing should never produce 'stop'
    expect(det.onPortRead(5000, 0, false)).toBeNull();
    expect(det.onPortRead(10000, 0, false)).toBeNull();
  });

  it('does NOT fire start when playing (only listens for stop in that state)', () => {
    // Even after 100 perfect start-pattern reads, no start event fires
    // because the caller said we're already playing.
    let t = 1000;
    det.onPortRead(t, 0, true);
    for (let i = 0; i < 50; i++) {
      t += 100;
      expect(det.onPortRead(t, i + 1, true)).toBeNull();
    }
  });
});

// ── Frame-boundary handling ─────────────────────────────────────────────

describe('LoaderDetector — onFrameEnd', () => {
  it('subtracts the frame length so cross-frame gaps stay correct', () => {
    // Build a 9-read run within a "frame" ending at T=69888 (48K frame)
    let t = 60000;
    det.onPortRead(t, 0, false);
    for (let i = 0; i < 8; i++) {
      t += 100;
      expect(det.onPortRead(t, i + 1, false)).toBeNull();
    }
    // Frame ends — the next frame's first read starts at T=200 absolute,
    // which would look like a HUGE gap (~69k) if we didn't adjust.
    det.onFrameEnd(69888);
    // Now t=60800 was adjusted to 60800 - 69888 = -9088
    // Next read at absolute T=200 → gap of 200 - (-9088) = 9288 — STILL too wide.
    // The frame adjustment only keeps timing sensible across ONE frame; this
    // test pins the math, not a real continuous-loader scenario.
    const ev = det.onPortRead(200, 9, false);
    expect(ev).toBeNull(); // gap > 500
  });

  it('a continuous loader straddling a frame boundary builds toward start', () => {
    let t = 69800;
    det.onPortRead(t, 0, false);
    // 5 reads in this frame
    for (let i = 0; i < 5; i++) {
      t += 10;
      expect(det.onPortRead(t, i + 1, false)).toBeNull();
    }
    // Frame end — push lastT back into the prior frame
    det.onFrameEnd(69888);
    // Continue in next frame; absolute T resets to small values
    t = 50;
    for (let i = 0; i < 4; i++) {
      t += 10;
      expect(det.onPortRead(t, 6 + i, false)).toBeNull();
    }
    t += 10;
    // 10th matching read across the boundary — should fire start
    expect(det.onPortRead(t, 10, false)).toBe('start');
  });
});

// ── Reset ───────────────────────────────────────────────────────────────

describe('LoaderDetector — reset', () => {
  it('clears the successive counter so a partial run doesn\'t leak past reset', () => {
    let t = 0;
    det.onPortRead(t, 0, false);
    for (let i = 0; i < 9; i++) {
      t += 100;
      det.onPortRead(t, i + 1, false);
    }
    det.reset();
    // Without reset this would be the 10th matching read → start.
    t += 100;
    expect(det.onPortRead(t, 10, false)).toBeNull();
  });

  it('clears the previous-read sentinel so the next read computes a fresh gap', () => {
    det.onPortRead(0, 0, false);
    det.onPortRead(100, 1, false);
    det.reset();
    // The next read is the new "first read"; even with a tiny absolute T it
    // should NOT count as matching against pre-reset state.
    expect(det.onPortRead(50, 2, false)).toBeNull();
  });
});

// ── Mode switching ───────────────────────────────────────────────────────

describe('LoaderDetector — switching modes between reads', () => {
  it('caller flipping playing=true mid-sequence stops counting toward start', () => {
    // The detector trusts the caller's `playing` flag every call.
    let t = 0;
    det.onPortRead(t, 0, false);
    for (let i = 0; i < 5; i++) {
      t += 100;
      det.onPortRead(t, i + 1, false);
    }
    // Caller manually started the tape — now passes playing=true
    t += 100;
    expect(det.onPortRead(t, 6, true)).toBeNull();
    // Even continuing matching reads should not fire start now
    for (let i = 0; i < 10; i++) {
      t += 100;
      expect(det.onPortRead(t, 7 + i, true)).toBeNull();
    }
  });
});
