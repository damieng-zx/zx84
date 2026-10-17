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

export class Apple2Cassette {
  private samples: Float32Array | null = null;
  private sampleRate = 0;
  private cursor = 0;
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
    this.level = 0;
    this.playing = false;
    this._name = '';
  }

  rewind(): void {
    this.cursor = 0;
    this.lastSign = 0;
    this.level = 0;
  }

  /** Advance the tape to emulated time `t` (seconds), toggling on zero
   *  crossings. A no-op while stopped or with no tape. */
  advanceTo(t: number): void {
    const samples = this.samples;
    if (!this.playing || !samples || samples.length === 0) return;
    let target = Math.floor(t * this.sampleRate);
    if (target <= this.cursor) return;
    if (target > samples.length) target = samples.length;
    for (let i = this.cursor; i < target; i++) {
      const sign = samples[i] >= 0 ? 1 : -1;
      if (sign !== this.lastSign) {
        this.lastSign = sign;
        this.level ^= 1;
      }
    }
    this.cursor = target;
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
