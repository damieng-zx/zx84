/**
 * Apple II cassette deck.
 *
 * The cassette interface is audio, not a bit stream: the drive plays the FSK
 * recording into a zero-crossing comparator whose output the CPU samples on
 * bit 7 of $C060, timing the gaps itself. So the deck keeps the decoded audio
 * and, as emulated time advances, walks the samples and toggles the input line
 * at each sign change — the comparator the ROM's read loop is measuring.
 */

import { parseWav, isWav } from '@/media/tape/wav.ts';

/** The comparator's dead band as a fraction of the recording's mean level: wide enough
 *  to ride over the noise on a digitised tape, narrow enough to follow its weakest pulses. */
const DEAD_BAND = 0.3;

export class Apple2Cassette {
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

  /** The cassette input level (bit 7 of $C060). */
  get inputBit(): number { return this.level & 1; }

  /** Fraction of the tape played, 0..1. */
  get progress(): number {
    if (!this.samples || this.samples.length === 0) return 0;
    return this.cursor / this.samples.length;
  }

  get finished(): boolean {
    return this.samples !== null && this.cursor >= this.samples.length;
  }
}
