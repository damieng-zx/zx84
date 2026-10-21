/**
 * Apple Cassette Interface tape deck.
 *
 * The interface is audio, not a bit stream: the recorder plays the tape into a
 * comparator whose output the CPU reads from bit 7 of `$C081`, timing the gaps
 * itself. So the deck keeps the decoded recording and, as emulated time
 * advances, walks the samples and flips the input line at each sign change —
 * the comparator the ROM's read loop is measuring.
 */

import { parseWav, isWav } from '@/media/tape/wav.ts';

export class Apple1Cassette {
  private samples: Float32Array | null = null;
  private sampleRate = 0;
  private cursor = 0;
  /** Playback position in samples, fractional so frame-sized steps don't drift. */
  private pos = 0;
  /** Emulated time of the last advanceTo, whether or not the tape was running. */
  private lastTime = 0;
  private lastSign = 0;
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

  /** Advance the tape to emulated time `t` (seconds), flipping the input on zero
   *  crossings. The tape moves only by the time elapsed while it is playing — `t`
   *  is the machine's absolute clock, not a position on the recording — so
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
      const sign = samples[i] >= 0 ? 1 : -1;
      if (sign !== this.lastSign) {
        this.lastSign = sign;
        this.level ^= 1;
      }
    }
    this.cursor = Math.max(this.cursor, target);
    if (this.cursor >= samples.length) this.playing = false;
  }

  /** The comparator output (bit 7 of `$C081`). */
  get inputBit(): number { return this.level & 1; }

  get finished(): boolean {
    return this.samples !== null && this.cursor >= this.samples.length;
  }
}
