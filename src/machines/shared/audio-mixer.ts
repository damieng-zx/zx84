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

/** Full-scale amplitude of the beeper path (before the DC-blocker). */
const BEEPER_SCALE = 0.8;
/** Amplitude of the auxiliary DAC path at a signed level of ±1. A DAC feeds a
 *  line-level output, so its full swing (±0.8) is twice the beeper's span. */
const AUX_SCALE = 0.8;
/** Highest aux gain: the DAC can be pushed above the speaker, since real drum
 *  samples only use part of the code range. */
const AUX_GAIN_MAX = 2;

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

  /**
   * The most recent accumulate call (its level and duration). When one call
   * straddles an output-sample boundary, `generateSamples` uses it to cut that
   * call at the boundary — the part before it belongs to this sample, the rest
   * starts the next — instead of smearing the whole window's average over both.
   */
  private beeperLastLevel = 0;
  private beeperLastElapsed = 0;

  /** DC-blocking filter for beeper */
  private beeperDCAlpha: number;
  private beeperDCPrev = 0;
  private beeperDCOut = 0;
  /** False until the filter has seen its first sample after construction/reset: that
   *  sample seeds the filter's history, so a signal that is already at a DC level
   *  (the beeper held high across a reset) starts at zero instead of stepping. */
  private beeperPrimed = false;

  /** Gain factors for PSG/beeper balance (clamped to 0..1). */
  private _beeperGain = 1.0;
  private _ayGain = 1.0;

  /**
   * Auxiliary analogue channel for a peripheral DAC (e.g. the SpecDrum): its own
   * time-weighted accumulator, DC-blocker and gain, so it balances independently of
   * the beeper and PSG. Dormant — and bit-identical to a mixer without it — until
   * `accumulateAux` is first called.
   *
   * Its input is a SIGNED level in -1..+1, centred on the DAC's idle code. An idle
   * DAC is therefore exactly zero: switching the channel on or off at idle, or
   * resetting it, can't step the output, and the filter needs no priming. (The
   * high-pass still removes a DC level if software parks the DAC off-centre.)
   */
  private auxActive = false;
  private auxAccum = 0;
  private auxLastLevel = 0;
  private auxLastElapsed = 0;
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

  /** Aux (DAC) gain, 0..2 — it may exceed 1, unlike the beeper/PSG balance. */
  get auxGain(): number { return this._auxGain; }
  set auxGain(v: number) { this._auxGain = v < 0 ? 0 : v > AUX_GAIN_MAX ? AUX_GAIN_MAX : v; }

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
    this.discardPending();
  }

  /** Accumulate beeper duty for the given elapsed T-states. */
  accumulate(beeperBit: number, elapsed: number): void {
    const bit = beeperBit & 1;
    this.beeperAccum += bit * elapsed;
    this.beeperTStatesAccum += elapsed;
    this.beeperLastLevel = bit;
    this.beeperLastElapsed = elapsed;
  }

  /** Accumulate an analogue speaker level (0..1) for the given elapsed
   *  T-states. For outputs that are a weighted mix of several digital lines
   *  (e.g. the Spectrum ULA's EAR + MIC resistor network) rather than a
   *  single 0/1 beeper bit. */
  accumulateLevel(level: number, elapsed: number): void {
    this.beeperAccum += level * elapsed;
    this.beeperTStatesAccum += elapsed;
    this.beeperLastLevel = level;
    this.beeperLastElapsed = elapsed;
  }

  /**
   * Accumulate the auxiliary DAC channel (signed level -1..+1, 0 = idle) for the
   * given elapsed T-states. Call it right after `accumulate`/`accumulateLevel` with
   * the same `elapsed` — the aux channel shares their sample window
   * (`beeperTStatesAccum`).
   */
  accumulateAux(level: number, elapsed: number): void {
    this.auxActive = true;
    this.auxAccum += level * elapsed;
    this.auxLastLevel = level;
    this.auxLastElapsed = elapsed;
  }

  /** Drop all pending (not yet emitted) duty: the beeper's window and the aux
   *  accumulator together. Turbo skips audio, so the window is zeroed each
   *  instruction — and the duty that goes with it must go too, or the next real
   *  sample would be normalised against a window it no longer matches. */
  discardPending(): void {
    this.beeperAccum = 0;
    this.beeperTStatesAccum = 0;
    this.beeperLastElapsed = 0;
    this.auxAccum = 0;
    this.auxLastElapsed = 0;
  }

  /** Generate audio samples when enough T-states have accumulated. */
  generateSamples(audio: Audio, psg: StereoAudioSource | null, psgEnabled: boolean): void {
    const tps = this.tStatesPerSample;
    while (this.beeperTStatesAccum >= tps) {
      // Time-weighted duty of the window. The common case — an instruction that
      // straddles the sample boundary — is cut exactly at the boundary. When more
      // is pending than one call can explain (catch-up: snapshot restore,
      // step-frame, deferred drain) the duty is spread proportionally across the
      // windows rather than dumped into the first sample, leaving silence after.
      const total = this.beeperTStatesAccum;
      const extra = total - tps;
      let duty: number;
      if (this.beeperLastElapsed > extra) {
        const carry = this.beeperLastLevel * extra;
        duty = (this.beeperAccum - carry) / tps;
        this.beeperAccum = carry;
        this.beeperLastElapsed = extra;
      } else {
        duty = this.beeperAccum / total;
        this.beeperAccum -= duty * tps;
        this.beeperLastElapsed = 0;
      }
      this.beeperTStatesAccum = extra;

      // DC-blocking high-pass filter: y[n] = alpha(y[n-1] + x[n] - x[n-1])
      const beeperRaw = duty * BEEPER_SCALE;
      if (!this.beeperPrimed) {
        this.beeperDCPrev = beeperRaw;
        this.beeperDCOut = 0;
        this.beeperPrimed = true;
      }
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
        // Same time-weighting and high-pass as the beeper, then mixed in mono at
        // the aux gain.
        let auxMean: number;
        if (this.auxLastElapsed > extra) {
          const carry = this.auxLastLevel * extra;
          auxMean = (this.auxAccum - carry) / tps;
          this.auxAccum = carry;
          this.auxLastElapsed = extra;
        } else {
          auxMean = this.auxAccum / total;
          this.auxAccum -= auxMean * tps;
          this.auxLastElapsed = 0;
        }
        const auxRaw = auxMean * AUX_SCALE;
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
    this.discardPending();
    this.beeperDCPrev = 0;
    this.beeperDCOut = 0;
    this.beeperPrimed = false;
    this.prevBeeperBit = 0;
    this.auxActive = false;
    this.auxDCPrev = 0;
    this.auxDCOut = 0;
  }
}
