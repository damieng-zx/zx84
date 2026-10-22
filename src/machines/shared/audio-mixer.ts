/**
 * Audio mixer peripheral: beeper accumulation, DC-blocking filter,
 * and stereo sample generation (beeper + programmable sound generator).
 *
 * Lives in `machines/shared/` because every machine (Spectrum, CPC, Einstein,
 * MSX, MTX) mixes its beeper/PSG output through it — it is genuinely machine-agnostic
 * DSP, not owned by any single machine folder.
 */

import type { Audio } from '@/audio.ts';
export interface StereoAudioSource {
  generateSampleStereo(): { left: number; right: number };
}

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

  /** Gain factors for PSG/beeper balance (clamped to 0..1). */
  private _beeperGain = 1.0;
  private _ayGain = 1.0;

  /**
   * Auxiliary analogue channel for a peripheral DAC (e.g. the SpecDrum): its own
   * time-weighted accumulator, DC-blocker and gain, so it balances independently of
   * the beeper and PSG. Dormant — and bit-identical to a mixer without it — until
   * `accumulateAux` is first called.
   */
  private auxActive = false;
  private auxAccum = 0;
  private auxDCPrev = 0;
  private auxDCOut = 0;
  private _auxGain = 1.0;

  get beeperGain(): number { return this._beeperGain; }
  set beeperGain(v: number) { this._beeperGain = clamp01(v); }

  get ayGain(): number { return this._ayGain; }
  set ayGain(v: number) { this._ayGain = clamp01(v); }
  /** Machine-neutral alias; `ayGain` remains for settings compatibility. */
  get psgGain(): number { return this._ayGain; }
  set psgGain(v: number) { this._ayGain = clamp01(v); }

  get auxGain(): number { return this._auxGain; }
  set auxGain(v: number) { this._auxGain = clamp01(v); }

  constructor(cpuClock: number) {
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
    this.auxAccum = 0;
  }

  /** Accumulate beeper duty for the given elapsed T-states. */
  accumulate(beeperBit: number, elapsed: number): void {
    const bit = beeperBit & 1;
    this.beeperAccum += bit * elapsed;
    this.beeperTStatesAccum += elapsed;
  }

  /** Accumulate an analogue speaker level (0..1) for the given elapsed
   *  T-states. For outputs that are a weighted mix of several digital lines
   *  (e.g. the Spectrum ULA's EAR + MIC resistor network) rather than a
   *  single 0/1 beeper bit. */
  accumulateLevel(level: number, elapsed: number): void {
    this.beeperAccum += level * elapsed;
    this.beeperTStatesAccum += elapsed;
  }

  /**
   * Accumulate the auxiliary DAC channel (level 0..1) for the given elapsed
   * T-states. Call it alongside `accumulate`/`accumulateLevel` with the same
   * `elapsed` — the aux channel shares their sample window (`beeperTStatesAccum`).
   */
  accumulateAux(level: number, elapsed: number): void {
    this.auxActive = true;
    this.auxAccum += level * elapsed;
  }

  /** Drop the aux channel's pending duty (turbo skips audio and zeroes the shared
   *  window, so the aux accumulator must follow or it would be mis-normalised). */
  discardAux(): void {
    this.auxAccum = 0;
  }

  /** Generate audio samples when enough T-states have accumulated. */
  generateSamples(audio: Audio, psg: StereoAudioSource | null, psgEnabled: boolean): void {
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
      if (psgEnabled && psg) {
        const psgSample = psg.generateSampleStereo();
        left = psgSample.left * this._ayGain + beeperOut * this._beeperGain;
        right = psgSample.right * this._ayGain + beeperOut * this._beeperGain;
      } else {
        left = beeperOut * this._beeperGain;
        right = beeperOut * this._beeperGain;
      }

      if (this.auxActive) {
        // Same time-weighting, scale and high-pass as the beeper, then mixed in
        // mono at the aux gain. `total` is the window before this sample was
        // taken off it (the beeper block above already subtracted it).
        const total = this.beeperTStatesAccum + this.tStatesPerSample;
        const auxDuty = this.auxAccum / total;
        this.auxAccum -= auxDuty * this.tStatesPerSample;
        const auxRaw = auxDuty * 0.8;
        this.auxDCOut = this.beeperDCAlpha * (this.auxDCOut + auxRaw - this.auxDCPrev);
        this.auxDCPrev = auxRaw;
        const auxOut = this.auxDCOut * this._auxGain;
        left += auxOut;
        right += auxOut;
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
    this.auxActive = false;
    this.auxAccum = 0;
    this.auxDCPrev = 0;
    this.auxDCOut = 0;
  }
}
