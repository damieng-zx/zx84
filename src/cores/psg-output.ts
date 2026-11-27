/**
 * The output stage shared by the two programmable sound generators (the
 * AY-3-891x family and the SN76489).
 *
 * Neither chip's *sound generation* has anything in common — the AY has three
 * tone dividers plus a 17-bit LFSR, the SN a 10-bit divider plus a 15/17-bit
 * LFSR with different taps, and their register maps are unrelated. What they do
 * share is everything that happens to the mixed output on its way to the host:
 *
 *   - the anti-aliasing strategy. The chips can emit ultrasonic tones (a channel
 *     parked at period 1 is ~110 kHz) that alias down into an audible whine when
 *     point-sampled, so the host chooses 'none', 'box' (average across the chip
 *     clocks in each output sample), 'mute' (silence a tone at or above Nyquist)
 *     or 'lowpass'.
 *   - AC coupling: the chip drives a coupling capacitor, modelled as a
 *     first-order DC-blocking high-pass, so a channel gated to a constant level
 *     is centred on zero rather than sitting at a DC offset.
 *   - the 'lowpass' anti-alias filter (a one-pole low-pass at the host's audio
 *     bandwidth).
 *
 * Each core still owns its register file, generators and tick rate; this stage
 * owns the resampling policy and the filters, so the two chips behave the same
 * at the output and there is one place to fix a filter bug.
 */

export type PsgAntialiasMode = 'none' | 'box' | 'mute' | 'lowpass';
/** Cutoff for the 'lowpass' anti-alias mode (one-pole), ~ Spectrum bandwidth. */
export const PSG_LOWPASS_CUTOFF_HZ = 14000;

/** Corner for the DC-blocking high-pass, low enough to leave bass untouched. */
const PSG_DC_CUTOFF_HZ = 20;

/** A stereo sample, reused so the hot path allocates nothing. */
export interface PsgSample {
  left: number;
  right: number;
}

/**
 * Resampler policy and filters for one PSG.
 *
 * Mono and stereo output keep separate filter state because they are separate
 * paths: a host drives one or the other for an instance's lifetime (the mixer
 * asks for stereo, a mockingboard's single AY for mono), and keeping them apart
 * means an occasional stray call on the other path cannot disturb the one in
 * use.
 */
export class PsgOutputStage {
  /**
   * The chip's anti-aliasing strategy.
   *
   *   none    — point-sampling (deterministic; aliases)
   *   box     — average the chip output across the clocks in each output sample
   *   mute    — treat a tone at or above Nyquist as a steady level, not a tone
   *   lowpass — low-pass the mixed output
   *
   * The core default is 'none' so conformance tests see the raw waveform; the
   * app sets the user's Sound-panel choice.
   */
  antialias: PsgAntialiasMode = 'none';

  /** AC coupling (the real chip's output capacitor). Off for conformance tests
   *  that compare against a DC-coupled reference. */
  dcBlocking = true;

  /** 'mute' threshold: a tone period at or above this is ultrasonic for the
   *  current clock/sample rate and is held steady instead of aliased. Sample
   *  rate dependent — see each core's recompute. */
  muteThresholdPeriod = 1;

  private dcAlpha: number;
  private lpAlpha: number;

  /** Per-path filter state: [0] = left/mono, [1] = right. */
  private readonly dcPrev = new Float64Array(2);
  private readonly dcOut = new Float64Array(2);
  private readonly lpOut = new Float64Array(2);
  private readonly monoDcPrev = new Float64Array(1);
  private readonly monoDcOut = new Float64Array(1);
  private readonly monoLpOut = new Float64Array(1);

  private readonly stereoOut: PsgSample = { left: 0, right: 0 };

  constructor(sampleRate = 44100) {
    this.dcAlpha = PsgOutputStage.dcCoefficient(sampleRate);
    this.lpAlpha = PsgOutputStage.lpCoefficient(sampleRate);
  }

  private static dcCoefficient(sampleRate: number): number {
    return 1 - (2 * Math.PI * PSG_DC_CUTOFF_HZ / sampleRate);
  }

  private static lpCoefficient(sampleRate: number): number {
    return 1 - Math.exp(-2 * Math.PI * PSG_LOWPASS_CUTOFF_HZ / sampleRate);
  }

  /** Recompute the filters for a new output rate (the AudioContext's real one). */
  setSampleRate(sampleRate: number): void {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) return;
    this.dcAlpha = PsgOutputStage.dcCoefficient(sampleRate);
    this.lpAlpha = PsgOutputStage.lpCoefficient(sampleRate);
  }

  /** Clear every filter's history (a reset, or a stereo mode change). */
  reset(): void {
    this.dcPrev.fill(0);
    this.dcOut.fill(0);
    this.lpOut.fill(0);
    this.monoDcPrev.fill(0);
    this.monoDcOut.fill(0);
    this.monoLpOut.fill(0);
  }

  /**
   * True when `period` puts the tone at or above the Nyquist frequency for the
   * current rate, so 'mute' should hold it steady rather than alias it.
   */
  isUltrasonic(period: number): boolean {
    return this.antialias === 'mute' && period <= this.muteThresholdPeriod;
  }

  /** Filter one mono sample of the core's mixed output. */
  processMono(raw: number): number {
    let out = raw;
    if (this.dcBlocking) {
      this.monoDcOut[0] = this.dcAlpha * (this.monoDcOut[0] + out - this.monoDcPrev[0]);
      this.monoDcPrev[0] = out;
      out = this.monoDcOut[0];
    }
    if (this.antialias === 'lowpass') {
      this.monoLpOut[0] += this.lpAlpha * (out - this.monoLpOut[0]);
      out = this.monoLpOut[0];
    }
    return out;
  }

  /** Filter one stereo sample of the core's mixed output, into a reused object. */
  processStereo(left: number, right: number): PsgSample {
    const out = this.stereoOut;
    let l = left;
    let r = right;
    if (this.dcBlocking) {
      this.dcOut[0] = this.dcAlpha * (this.dcOut[0] + l - this.dcPrev[0]);
      this.dcPrev[0] = l;
      l = this.dcOut[0];
      this.dcOut[1] = this.dcAlpha * (this.dcOut[1] + r - this.dcPrev[1]);
      this.dcPrev[1] = r;
      r = this.dcOut[1];
    }
    if (this.antialias === 'lowpass') {
      this.lpOut[0] += this.lpAlpha * (l - this.lpOut[0]);
      this.lpOut[1] += this.lpAlpha * (r - this.lpOut[1]);
      l = this.lpOut[0];
      r = this.lpOut[1];
    }
    out.left = l;
    out.right = r;
    return out;
  }
}