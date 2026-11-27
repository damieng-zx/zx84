/**
 * The Oric's cassette interface.
 *
 * The tape hangs off VIA port B: PB6 is the motor relay, PB7 the data output,
 * and CB1 the data input. The ROM's loader is a software FSK decoder — it times
 * the intervals between edges on CB1 with a VIA timer — so the machine only has
 * to present an edge-accurate data line and collect what the ROM drives out.
 *
 * Encoding, from the hardware reference: two tones, 2400 Hz and 1200 Hz. In
 * SLOW mode a bit is four periods at 1200 Hz (`0`) or eight at 2400 Hz (`1`),
 * giving 300 baud; in FAST mode a `1` is one 2400 Hz period and a `0` is half
 * of a 2400 Hz period plus half of a 1200 Hz period. Either way the ROM writes
 * **thirteen bits** per byte: a start `0`, eight data bits, a parity bit, and
 * three `1` stop bits.
 *
 * This class owns the *timing*: it turns a `.tap` into the level the data line
 * carries at any CPU cycle, and it turns the levels the ROM writes back into
 * pulses for a recording. The `.tap` byte stream itself is `oric-tap.ts`.
 */

import type { TapeBlock } from '@/media/tape/tap.ts';
import {
  ORIC_TAP_SYNC, type OricTapFile,
} from '@/media/tape/oric-tap.ts';
import { PulseRecorder } from '@/media/tape/pulse-recorder.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

/** Cycles in one half-period of each tone at the CPU clock. */
function halfPeriod(clockHz: number, hz: number): number {
  return Math.max(1, Math.round(clockHz / hz / 2));
}

/**
 * The audio the ROM's own SAVE produces, as a level over time.
 *
 * A `.tap` is the *bytes*; playing one back means synthesising the tones the
 * loader expects. This converts a byte stream to the level changes of the
 * recorder signal, which is exactly what the deck then plays.
 */
export class OricTapeEncoder {
  /** Cycles at 1200 Hz and 2400 Hz half-periods. */
  private readonly half1200: number;
  private readonly half2400: number;

  constructor(cpuClock: number) {
    this.half1200 = halfPeriod(cpuClock, 1200);
    this.half2400 = halfPeriod(cpuClock, 2400);
  }

  /**
   * The level changes for one byte, as `[cycles, level]` pairs starting from a
   * low level. Thirteen bits: start 0, eight data bits low bit first, parity,
   * three stop 1s. A bit is four 1200 Hz periods for `0` and eight 2400 Hz
   * periods for `1` (SLOW, the ROM's default save format).
   */
  bytePulses(value: number): { cycles: number; level: number }[] {
    const bits: number[] = [0];
    for (let i = 0; i < 8; i++) bits.push((value >> i) & 1);
    let ones = 0;
    for (let i = 0; i < 8; i++) if ((value >> i) & 1) ones++;
    bits.push(ones & 1);      // parity
    bits.push(1, 1, 1);        // stop bits

    const out: { cycles: number; level: number }[] = [];
    let level = 0;
    for (const bit of bits) {
      // Each bit is a run of half-period toggles at the bit's tone.
      const half = bit ? this.half2400 : this.half1200;
      const toggles = bit ? 16 : 8;      // eight periods of 2400, four of 1200
      for (let i = 0; i < toggles; i++) {
        out.push({ cycles: half, level });
        level ^= 1;
      }
    }
    return out;
  }

  /**
   * The whole tape's level over time, as pulse lengths at `level`.
   *
   * A `.tap` file's payload is wrapped in its leader and sync, so this
   * synthesises a leader tone, the sync, the header, the name and the payload —
   * the same byte stream the ROM would read, played as tones.
   */
  encode(files: readonly OricTapFile[]): TapeBlock[] {
    const pulses: number[] = [];
    for (const file of files) {
      // The leader: a run of low tone, then the sync starts the framing.
      for (let i = 0; i < Math.max(1, file.leaderLength); i++) {
        pulses.push(...this.runLevel(this.half1200, 8));
      }
      for (const p of this.bytePulses(ORIC_TAP_SYNC)) pulses.push(p.cycles);
      const header = [
        0, 0, file.type, file.autorun ? 0xC7 : 0,
        (file.end >> 8) & 0xFF, file.end & 0xFF,
        (file.start >> 8) & 0xFF, file.start & 0xFF, 0,
      ];
      for (const b of header) for (const p of this.bytePulses(b)) pulses.push(p.cycles);
      for (const ch of file.name) for (const p of this.bytePulses(ch.charCodeAt(0) & 0xFF)) pulses.push(p.cycles);
      for (const p of this.bytePulses(0)) pulses.push(p.cycles);
      for (const b of file.data) for (const p of this.bytePulses(b)) pulses.push(p.cycles);
    }
    return pulses.length > 0 ? [{ kind: 'pulses', lengths: pulses }] : [];
  }

  /** `toggles` half-periods at `half`, as pulse lengths. */
  private runLevel(half: number, toggles: number): number[] {
    return Array.from({ length: toggles }, () => half);
  }
}

/**
 * The deck: the mounted tape's data line, plus a recorder of what the ROM saves.
 *
 * The data line is fed from the mounted tape's pulse list, advanced by the CPU
 * cycles the machine steps, exactly as the shared cassette drives do — the
 * difference is only which VIA pins carry it.
 */
export class OricTape {
  /** Half-period of each tone, in CPU cycles. */
  readonly recorder: PulseRecorder;
  /** Turns a `.tap` into the tones the ROM's loader reads. */
  readonly encoder: OricTapeEncoder;
  /** Mounted tape's pulse lengths (cycles low, cycles high, …) and position. */
  private pulses: Uint32Array = new Uint32Array(0);
  private at = 0;
  private remaining = 0;
  /** Current data-line level (1 = high). */
  level = 1;
  /** The deck is moving: the ROM has the motor on and the user has not paused. */
  playing = false;
  paused = true;
  loaded = false;
  name = '';

  constructor(cpuClock: number) {
    this.recorder = new PulseRecorder();
    this.encoder = new OricTapeEncoder(cpuClock);
  }

  /** Mount an encoder's blocks as the tape's signal. */
  mount(blocks: readonly TapeBlock[]): boolean {
    const lengths: number[] = [];
    for (const block of blocks) {
      if (block.kind === 'pulses') lengths.push(...block.lengths);
    }
    if (lengths.length === 0) return false;
    this.pulses = Uint32Array.from(lengths);
    this.at = 0;
    this.remaining = this.pulses[0] ?? 0;
    this.level = 0;
    this.loaded = true;
    this.paused = true;
    this.playing = false;
    return true;
  }

  eject(): void {
    this.pulses = new Uint32Array(0);
    this.at = 0;
    this.remaining = 0;
    this.level = 1;
    this.loaded = false;
    this.playing = false;
    this.paused = true;
    this.name = '';
  }

  /** The motor relay, driven from VIA PB6. */
  setMotor(on: boolean): void {
    this.playing = on && !this.paused;
  }

  /** The ROM wrote a level to PB7, or the timer toggled it; record the edge. */
  observeOutput(level: number, now: number): void {
    this.recorder.observe(level ? 1 : 0, now);
  }

  /** Advance the data line by `elapsed` cycles. */
  advance(elapsed: number): void {
    // Nothing mounted, or the deck isn't moving: the line is static, so there
    // is no work to do per instruction (this is a tier-1 hot path).
    if (!this.playing || this.at >= this.pulses.length) return;
    let left = elapsed;
    while (left > 0 && this.at < this.pulses.length) {
      if (left < this.remaining) {
        this.remaining -= left;
        return;
      }
      left -= this.remaining;
      this.at++;
      if (this.at >= this.pulses.length) break;
      this.level ^= 1;
      this.remaining = this.pulses[this.at];
    }
  }

  /** The data line CB1 reads. */
  get earBit(): number { return this.level; }

  /** Position in the pulse list, for the tape pane. */
  get position(): number { return this.at; }
  get finished(): boolean { return this.loaded && this.at >= this.pulses.length; }

  reset(): void {
    this.at = 0;
    this.remaining = this.pulses[0] ?? 0;
    this.level = 1;
    this.playing = false;
    this.paused = true;
    this.recorder.reset();
  }

  saveState(w: StateWriter): void {
    w.u32(this.pulses.length);
    w.raw(new Uint8Array(this.pulses.buffer, this.pulses.byteOffset, this.pulses.byteLength));
    w.u32(this.at);
    w.u32(this.remaining);
    w.u8(this.level);
    w.bool(this.loaded);
    w.bool(this.playing);
    w.bool(this.paused);
    w.str(this.name);
    this.recorder.saveState(w);
  }

  loadState(r: StateReader): void {
    const count = r.u32();
    this.pulses = new Uint32Array(count);
    const raw = new Uint8Array(count * 4);
    r.rawInto(raw);
    this.pulses.set(new Uint32Array(raw.buffer, raw.byteOffset, count));
    this.at = r.u32();
    this.remaining = r.u32();
    this.level = r.u8();
    this.loaded = r.bool();
    this.playing = r.bool();
    this.paused = r.bool();
    this.name = r.str();
    this.recorder.loadState(r);
  }
}
