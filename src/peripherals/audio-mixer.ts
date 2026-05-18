/**
 * Audio mixer peripheral: beeper accumulation, DC-blocking filter,
 * and stereo sample generation (beeper + AY).
 */

import type { Audio } from '@/audio.ts';
import type { AY3891x } from '@/cores/ay-3-8910.ts';
import { Z80_CLOCK_48K } from '@/contention.ts';

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class AudioMixer {
  /** Previous beeper state for toggle detection (read by io-ports.ts) */
  prevBeeperBit = 0;

  /** T-states per audio sample */
  tStatesPerSample: number;

  /** CPU clock speed in Hz */
  private cpuClock: number;

  /** Beeper duty cycle accumulator for current audio sample */
  private beeperAccum = 0;
  beeperTStatesAccum = 0;

  /** DC-blocking filter for beeper */
  private beeperDCAlpha: number;
  private beeperDCPrev = 0;
  private beeperDCOut = 0;

  /** Gain factors for AY/beeper balance (clamped to 0..1) */
  private _beeperGain = 1.0;
  private _ayGain = 1.0;

  get beeperGain(): number { return this._beeperGain; }
  set beeperGain(v: number) { this._beeperGain = clamp01(v); }

  get ayGain(): number { return this._ayGain; }
  set ayGain(v: number) { this._ayGain = clamp01(v); }

  constructor(cpuClock = Z80_CLOCK_48K) {
    this.cpuClock = cpuClock;
    // Default to 44100 Hz so the mixer is usable without an explicit init().
    // Audio drivers should still call init(audio.sampleRate) but a missing
    // init must not silently mute the beeper.
    this.tStatesPerSample = cpuClock / 44100;
    this.beeperDCAlpha = 1 - (2 * Math.PI * 20 / 44100);
  }

  /** Compute tStatesPerSample and DC alpha from actual audio sample rate. */
  init(sampleRate: number): void {
    this.tStatesPerSample = this.cpuClock / sampleRate;
    // DC-blocking filter: ~20Hz cutoff, same as AY core
    this.beeperDCAlpha = 1 - (2 * Math.PI * 20 / sampleRate);
    // Drop in-flight accumulator state so a mid-stream sample-rate change
    // doesn't reinterpret old T-state counts in the new window size.
    this.beeperAccum = 0;
    this.beeperTStatesAccum = 0;
  }

  /** Accumulate beeper duty for the given elapsed T-states. */
  accumulate(beeperBit: number, elapsed: number): void {
    const bit = beeperBit & 1;
    this.beeperAccum += bit * elapsed;
    this.beeperTStatesAccum += elapsed;
  }

  /** Generate audio samples when enough T-states have accumulated. */
  generateSamples(audio: Audio, ay: AY3891x | null, is128k: boolean): void {
    while (this.beeperTStatesAccum >= this.tStatesPerSample) {
      // Time-weighted duty across the currently accumulated window. When
      // multiple sample windows are pending (catch-up: snapshot restore,
      // step-frame, deferred drain) we spread the duty proportionally
      // across them rather than dumping it all into the first sample and
      // playing silence for the rest.
      const duty = this.beeperAccum / this.beeperTStatesAccum;
      this.beeperAccum -= duty * this.tStatesPerSample;
      this.beeperTStatesAccum -= this.tStatesPerSample;

      // DC-blocking high-pass filter: y[n] = alpha(y[n-1] + x[n] - x[n-1])
      const beeperRaw = duty * 0.8;
      this.beeperDCOut = this.beeperDCAlpha * (this.beeperDCOut + beeperRaw - this.beeperDCPrev);
      this.beeperDCPrev = beeperRaw;
      const beeperOut = this.beeperDCOut;

      let left: number, right: number;
      if (is128k && ay) {
        const aySample = ay.generateSampleStereo();
        left = aySample.left * this._ayGain + beeperOut * this._beeperGain;
        right = aySample.right * this._ayGain + beeperOut * this._beeperGain;
      } else {
        left = beeperOut * this._beeperGain;
        right = beeperOut * this._beeperGain;
      }

      audio.pushSample(
        Math.max(-1, Math.min(1, left)),
        Math.max(-1, Math.min(1, right))
      );
    }
  }

  reset(): void {
    this.beeperAccum = 0;
    this.beeperTStatesAccum = 0;
    this.beeperDCPrev = 0;
    this.beeperDCOut = 0;
    this.prevBeeperBit = 0;
  }
}
