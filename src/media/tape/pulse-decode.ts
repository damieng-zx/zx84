/**
 * Pulse-train decoding for recorded cassette output.
 *
 * Most 8-bit cassette formats in the "pilot, sync, then bits as pairs of
 * equal half-cycles" family (the ZX Spectrum ROM, the Amstrad CPC firmware,
 * and the turbo loaders derived from them) share one shape:
 *
 *   leader   a long run of equal pulses (the pilot tone)
 *   sync     two pulses shorter than the pilot
 *   data     one full cycle per bit, MSB first; a 1 is wider than a 0
 *
 * `findPulseBlocks` finds every such block in a pulse train and reads its
 * bytes, asking the caller (who knows its machine's ROM) whether a pilot of a
 * given width belongs to an encoding it recognises. `pulsesToTzxBlocks`
 * turns a whole recording into TZX blocks: recognised blocks become data
 * blocks, anything else that starts with a leader is kept verbatim as exact
 * pulse widths, and silences become pauses.
 *
 * All widths here are in whatever unit the caller passes; `pulsesToTzxBlocks`
 * expects 3.5 MHz reference T-states (the TZX unit).
 */

import type { TzxOutBlock } from '@/media/tape/tzx-writer.ts';
import { TAPE_REF_HZ } from '@/media/tape/tap.ts';

/** Bit geometry of a recognised encoding, in the train's units. */
export interface BitGeometry {
  readonly sync1: number;
  readonly sync2: number;
  readonly bit0: number;
  readonly bit1: number;
  /** Widest pulse still read as a data half-cycle (default 1.35 × bit1).
   *  Lower it when the pilot is only a little wider than a 1, so data running
   *  straight into the next leader stops at the leader. */
  readonly maxBit?: number;
}

/** One decoded block, with what was measured from the pulses themselves. */
export interface PulseBlock {
  /** Index of the first leader pulse. */
  readonly start: number;
  /** Index of the first pulse after the block (not part of it). */
  readonly end: number;
  /** Mean pilot width and number of pilot pulses. */
  readonly pilot: number;
  readonly pilotCount: number;
  readonly sync1: number;
  readonly sync2: number;
  /** Mean measured half-cycle widths of the 0 and 1 bits. */
  readonly bit0: number;
  readonly bit1: number;
  /** Bytes, MSB first; a partial last byte is left-aligned. */
  readonly data: Uint8Array;
  /** Bits used in the last byte (1–8). */
  readonly usedBits: number;
  /** When the final bit's second half-cycle ran on into silence (no closing
   *  edge), the silence beyond it; else 0. */
  readonly tailGap: number;
}

/** Pilot pulses must stay within this fraction of the running mean. */
const PILOT_TOLERANCE = 0.1;
/** Sync pulses within this fraction of the geometry's. */
const SYNC_TOLERANCE = 0.45;
/** A leader must be at least this long. The Spectrum ROM writes 3223 pulses
 *  before a data block, the CPC firmware 4096; real loaders need hundreds to
 *  lock on. Far above the few pulses of a click or a short beep. */
export const MIN_LEADER = 256;

/** End index of the run of near-equal pulses starting at `i`. */
export function leaderEnd(pulses: ArrayLike<number>, i: number, end: number): number {
  let sum = pulses[i];
  let j = i + 1;
  while (j < end) {
    const mean = sum / (j - i);
    const p = pulses[j];
    if (Math.abs(p - mean) > mean * PILOT_TOLERANCE) break;
    sum += p;
    j++;
  }
  return j;
}

/** Whether pulses[s, e) contain a leader of at least `minLeader` pulses. */
export function hasLeader(pulses: ArrayLike<number>, s: number, e: number, minLeader = MIN_LEADER): boolean {
  for (let i = s; i + minLeader <= e;) {
    const j = leaderEnd(pulses, i, e);
    if (j - i >= minLeader) return true;
    i = j > i + 1 ? j : i + 1;
  }
  return false;
}

function near(v: number, want: number, tol: number): boolean {
  return Math.abs(v - want) <= want * tol;
}

/**
 * Find and read every pilot/sync/data block in a pulse train.
 * `geometryFor(pilot)` returns the bit geometry for a leader of that mean
 * width, or null when the caller does not recognise it.
 */
export function findPulseBlocks(
  pulses: ArrayLike<number>,
  geometryFor: (pilot: number) => BitGeometry | null,
  minLeader = MIN_LEADER,
): PulseBlock[] {
  const n = pulses.length;
  const blocks: PulseBlock[] = [];
  let i = 0;
  while (i < n) {
    const j = leaderEnd(pulses, i, n);
    const run = j - i;
    if (run < minLeader) { i = j > i + 1 ? j : i + 1; continue; }
    let pilotSum = 0;
    for (let p = i; p < j; p++) pilotSum += pulses[p];
    const pilot = pilotSum / run;
    const g = geometryFor(pilot);
    if (!g || j + 1 >= n
      || !near(pulses[j], g.sync1, SYNC_TOLERANCE) || !near(pulses[j + 1], g.sync2, SYNC_TOLERANCE)) {
      i = j;
      continue;
    }

    const lo = g.bit0 * 0.5;
    const hi = g.maxBit ?? g.bit1 * 1.35;
    const mid = (g.bit0 + g.bit1) / 2;
    const pairMid = g.bit0 + g.bit1;
    const bytes = new Uint8Array(((n - j) >> 4) + 1);
    let nBytes = 0;
    let acc = 0;
    let nBits = 0;
    let sum0 = 0, cnt0 = 0, sum1 = 0, cnt1 = 0;
    let tailGap = 0;
    let k = j + 2;
    const half = (w: number): void => {
      if (w > mid) { sum1 += w; cnt1++; } else { sum0 += w; cnt0++; }
    };
    const push = (bit: number): void => {
      acc = (acc << 1) | bit;
      if (++nBits % 8 === 0) { bytes[nBytes++] = acc & 0xFF; acc = 0; }
    };
    while (k < n) {
      const a = pulses[k];
      if (a < lo || a > hi) break;
      if (k + 1 >= n || pulses[k + 1] > hi) {
        // A lone half-cycle before silence. When it would complete a byte it
        // is the last bit, whose second half ran on into the silence (or the
        // recording ended): read the bit from the first half. Otherwise it is
        // the saver's closing edge (the Spectrum ROM toggles MIC once more as
        // it restores the border), not data.
        if (nBits % 8 !== 7) break;
        half(a);
        push(a > mid ? 1 : 0);
        if (k + 1 < n) tailGap = Math.max(0, pulses[k + 1] - a);
        k += k + 1 < n ? 2 : 1;
        break;
      }
      const b = pulses[k + 1];
      if (b < lo) break;
      half(a);
      half(b);
      push(a + b > pairMid ? 1 : 0);
      k += 2;
    }
    if (nBits < 8) { i = j; continue; }
    const rem = nBits % 8;
    if (rem) bytes[nBytes++] = (acc << (8 - rem)) & 0xFF;
    blocks.push({
      start: i, end: k, pilot, pilotCount: run,
      sync1: pulses[j], sync2: pulses[j + 1],
      bit0: cnt0 ? sum0 / cnt0 : g.bit0,
      bit1: cnt1 ? sum1 / cnt1 : g.bit1,
      data: bytes.slice(0, nBytes),
      usedBits: rem || 8,
      tailGap,
    });
    i = k;
  }
  return blocks;
}

/** A silence at least this long separates blocks (100 ms). */
const GAP_T = TAPE_REF_HZ / 10;
/** Ceiling on the pause written after the last block. */
const FINAL_PAUSE_MS = 1000;

const toMs = (t: number): number => Math.min(0xFFFF, Math.round(t * 1000 / TAPE_REF_HZ));

/**
 * Turn a recording (pulse widths in 3.5 MHz reference T-states) into TZX
 * blocks. `toBlock` converts each recognised block into the data block the
 * machine's own format uses (its `pause` is filled in here). Stretches that
 * are not recognised are kept as exact pulse widths (a CSW recording block)
 * when they contain a leader — every loader needs one, so anything without a
 * leader is a click or a sound effect on the output line, not a save — and
 * dropped otherwise. Silence before the first block is dropped.
 */
export function pulsesToTzxBlocks(
  pulses: ArrayLike<number>,
  geometryFor: (pilot: number) => BitGeometry | null,
  toBlock: (block: PulseBlock) => TzxOutBlock,
): TzxOutBlock[] {
  const out: TzxOutBlock[] = [];
  let gap = 0;
  const emit = (b: TzxOutBlock): void => {
    setPause(gap);
    gap = 0;
    out.push(b);
  };
  const setPause = (t: number): void => {
    const last = out[out.length - 1];
    if (last && (last.kind === 'standard' || last.kind === 'turbo' || last.kind === 'csw')) {
      last.pause = toMs(t);
    } else if (last && t > 0) {
      out.push({ kind: 'pause', ms: toMs(t) });
    }
  };
  const raw = (s: number, e: number): void => {
    let runStart = s;
    for (let p = s; p <= e; p++) {
      if (p < e && pulses[p] < GAP_T) continue;
      // [runStart, p) is a stretch of short pulses; pulses[p] (if any) a silence.
      if (p > runStart) {
        if (hasLeader(pulses, runStart, p)) {
          emit({ kind: 'csw', pulses: Array.prototype.slice.call(pulses, runStart, p) as number[], pause: 0 });
        } else {
          for (let q = runStart; q < p; q++) gap += pulses[q];
        }
      }
      if (p < e) gap += pulses[p];
      runStart = p + 1;
    }
  };

  let cursor = 0;
  for (const block of findPulseBlocks(pulses, geometryFor)) {
    raw(cursor, block.start);
    emit(toBlock(block));
    gap += block.tailGap;
    cursor = block.end;
  }
  raw(cursor, pulses.length);
  if (out.length > 0) setPause(Math.min(gap, FINAL_PAUSE_MS * TAPE_REF_HZ / 1000));
  return out;
}
