/**
 * A cassette deck for machines whose tape port is audio, not a bit stream (the
 * Apple I's Cassette Interface and the Apple II's tape port).
 *
 * The recorder plays the recording into a zero-crossing comparator whose output
 * the CPU samples on a single input bit, timing the gaps itself. So the deck
 * keeps the decoded audio and, as emulated time advances, walks the samples and
 * toggles the input line at each sign change — the comparator the ROM's read
 * loop is measuring. Which bit of which port carries the line is the machine's
 * business.
 */

import { parseWav, isWav } from '@/media/tape/wav.ts';
import type { StateReader, StateWriter } from './state-io.ts';

/** The comparator's dead band as a fraction of the recording's mean level: wide enough
 *  to ride over the noise on a digitised tape, narrow enough to follow its weakest pulses. */
const DEAD_BAND = 0.3;

export class AudioCassette {
  private samples: Float32Array | null = null;
  private sampleRate = 0;
  private cursor = 0;
  /** Playback position in samples, fractional so frame-sized steps don't drift. */
  private pos = 0;
  /** Emulated time of the last advanceTo, whether or not the tape was running. */
  private lastTime = 0;
  private lastSign = 0;
  /** Half-width of the comparator's hysteresis, in sample units, set from the recording's level. */
  private deadBand = 0;
  private level = 0;

  playing = false;
  private _name = '';

  get loaded(): boolean { return this.samples !== null; }
  get name(): string { return this._name; }

  /** Mount a WAV recording. */
  mountWav(data: Uint8Array, name: string): boolean {
    if (!isWav(data)) return false;
    const audio = parseWav(data);
    if (audio.samples.length === 0) return false;
    this.samples = audio.samples;
    this.sampleRate = audio.sampleRate;
    let level = 0;
    for (let i = 0; i < audio.samples.length; i++) level += Math.abs(audio.samples[i]);
    this.deadBand = DEAD_BAND * (level / audio.samples.length);
    this.cursor = 0;
    this.pos = 0;
    this.lastSign = 0;
    this.level = 0;
    this.playing = false;
    this._name = name;
    return true;
  }

  eject(): void {
    this.samples = null;
    this.sampleRate = 0;
    this.cursor = 0;
    this.pos = 0;
    this.level = 0;
    this.playing = false;
    this._name = '';
  }

  rewind(): void {
    this.cursor = 0;
    this.pos = 0;
    this.lastSign = 0;
    this.level = 0;
  }

  /** Advance the tape to emulated time `t` (seconds), toggling on zero
   *  crossings. The tape moves only by the time elapsed while it is playing —
   *  `t` is the machine's absolute clock, not a position on the recording — so
   *  starting, pausing or resuming mid-session never skips audio. */
  advanceTo(t: number): void {
    const dt = t - this.lastTime;
    this.lastTime = t;
    const samples = this.samples;
    if (!this.playing || !samples || samples.length === 0) return;
    if (dt <= 0) return;                         // CPU reset rewinds the clock
    this.pos = Math.min(samples.length, this.pos + dt * this.sampleRate);
    const target = Math.floor(this.pos);
    for (let i = this.cursor; i < target; i++) {
      // A Schmitt trigger: the level only changes once the signal clears the dead
      // band on the other side, so tape noise around zero does not chatter.
      const s = samples[i];
      const sign = s > this.deadBand ? 1 : s < -this.deadBand ? -1 : this.lastSign;
      if (sign !== this.lastSign) {
        this.lastSign = sign;
        this.level ^= 1;
      }
    }
    this.cursor = Math.max(this.cursor, target);
    if (this.cursor >= samples.length) this.playing = false;
  }

  /** The comparator output level, for the machine to present on its input bit. */
  get inputBit(): number { return this.level & 1; }

  /** Fraction of the tape played, 0..1. */
  get progress(): number {
    if (!this.samples || this.samples.length === 0) return 0;
    return this.cursor / this.samples.length;
  }

  get finished(): boolean {
    return this.samples !== null && this.cursor >= this.samples.length;
  }

  // ── Snapshot state ────────────────────────────────────────────────────────

  /**
   * Write the deck's position and comparator; with `withMedia`, the recording
   * too. The recording is stored as what the comparator makes of it rather
   * than as audio: the run of levels it settles on, sample by sample, which
   * is all that ever reaches the machine. Played back through the same
   * comparator that run gives the same toggles at the same samples, and it is
   * a few kilobytes where the audio is megabytes. Without the media (the
   * browser-refresh path) the shell remounts the recording from its store.
   */
  saveState(w: StateWriter, withMedia: boolean): void {
    w.f64(this.lastTime);
    w.bool(withMedia);
    if (!withMedia) return;
    const samples = this.samples;
    w.bool(samples !== null);
    if (!samples) return;
    w.str(this._name);
    w.f64(this.sampleRate);
    w.u32(samples.length);
    // Runs of the comparator's settled sign (-1, +1, or 0 before the first
    // sample clears the dead band), resolved from the start of the tape as
    // `advanceTo` does after a mount or rewind.
    const runs: number[] = [];
    let sign = 0;
    let runSign = 0;
    let runLen = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      sign = s > this.deadBand ? 1 : s < -this.deadBand ? -1 : sign;
      if (sign === runSign) { runLen++; continue; }
      if (runLen > 0) runs.push(runSign, runLen);
      runSign = sign;
      runLen = 1;
    }
    if (runLen > 0) runs.push(runSign, runLen);
    w.u32(runs.length / 2);
    for (let i = 0; i < runs.length; i += 2) { w.u8(runs[i] + 1); w.u32(runs[i + 1]); }
    w.u32(this.cursor); w.f64(this.pos); w.i32(this.lastSign); w.u8(this.level); w.bool(this.playing);
  }

  loadState(r: StateReader): void {
    this.lastTime = r.f64();
    if (!r.bool()) return;
    if (!r.bool()) { this.eject(); return; }
    const name = r.str();
    const sampleRate = r.f64();
    const length = r.u32();
    if (length > 1 << 30) throw new Error('Snapshot is corrupt (cassette)');
    const samples = new Float32Array(length);
    let at = 0;
    for (let n = r.u32(); n > 0; n--) {
      const sign = r.u8() - 1;
      const run = r.u32();
      if (at + run > length) throw new Error('Snapshot is corrupt (cassette)');
      samples.fill(sign, at, at + run);
      at += run;
    }
    this.samples = samples;
    this.sampleRate = sampleRate;
    // Levels of exactly ±1 against a half-unit dead band: every settled sample
    // clears it and every unsettled (0) one does not, as before.
    this.deadBand = 0.5;
    this._name = name;
    this.cursor = r.u32(); this.pos = r.f64(); this.lastSign = r.i32(); this.level = r.u8(); this.playing = r.bool();
  }
}
