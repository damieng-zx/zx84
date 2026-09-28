/**
 * Texas Instruments SN76489AN / SN76496 programmable sound generator.
 *
 * Commodity silicon used by the Memotech MTX, ColecoVision, Sord M5,
 * Sega SG-1000/SC-3000, BBC Micro and a number of other systems.
 *
 * The chip exposes one write-only byte port. A byte with bit 7 set latches one
 * of eight registers and supplies its low four data bits; a following byte
 * with bit 7 clear supplies the upper six bits of a latched tone period.
 *
 * Noise shift-register width and feedback taps varied between implementations.
 * Select the machine's fitted part explicitly when that distinction matters.
 */

export type Sn76489Variant = 'ti-15bit' | 'sega' | 'mtx';

/**
 * Stereo placement of the three tone channels, named left-centre-right (the
 * same set the AY offers). The chip itself is mono — 'MONO' is the hardware —
 * so the split is a presentation choice. The noise channel stays centred.
 */
export type Sn76489StereoMode = 'MONO' | 'ABC' | 'ACB' | 'BAC' | 'BCA' | 'CAB' | 'CBA';

/** Left/right weight of each tone channel (A, B, C) for a stereo mode: the
 *  first-named channel is hard left, the second centred, the third hard right. */
function panWeights(mode: Sn76489StereoMode): { left: Float64Array; right: Float64Array } {
  const left = new Float64Array(3);
  const right = new Float64Array(3);
  if (mode === 'MONO') return { left: left.fill(0.5), right: right.fill(0.5) };
  const ch = (letter: string) => letter.charCodeAt(0) - 65;
  left[ch(mode[0])] = 1;
  left[ch(mode[1])] = 0.5; right[ch(mode[1])] = 0.5;
  right[ch(mode[2])] = 1;
  return { left, right };
}

export interface StereoPsgSample {
  left: number;
  right: number;
}

// Resampler anti-aliasing strategy for the SN76489 output stage — mirrors
// AYAntialiasMode (src/cores/ay-3-8910.ts). A channel parked at a low tone
// period is ultrasonic on real hardware but aliases down into the audible
// band as a whine when the output is naively point-sampled.
//   none    — legacy point-sampling (no anti-aliasing; aliases)
//   box     — average the chip output across the clocks in each output sample
//   mute    — treat a tone at or above Nyquist for the current sample rate as
//             silent (see Sn76489.muteThresholdPeriod — sample-rate
//             dependent, not just period 1)
//   lowpass — low-pass the mixed output, modelling the host's audio bandwidth
export type Sn76489AntialiasMode = 'none' | 'box' | 'mute' | 'lowpass';

// Cutoff for the 'lowpass' anti-alias mode (one-pole), matching the AY core.
const LP_CUTOFF_HZ = 14000;

/** Measured/logarithmic 2 dB attenuation steps, normalised to 1.0. */
export const SN76489_VOLUME_TABLE = new Float64Array([
  1.000000, 0.794328, 0.630957, 0.501187,
  0.398107, 0.316228, 0.251189, 0.199526,
  0.158489, 0.125893, 0.100000, 0.079433,
  0.063096, 0.050119, 0.039811, 0.000000,
]);

export class Sn76489 {
  readonly tonePeriod = new Uint16Array(3);
  readonly attenuation = new Uint8Array([15, 15, 15, 15]);

  noiseControl = 0;
  latchedRegister = 0;

  private readonly toneCounter = new Int32Array(3);
  private readonly toneOutput = new Uint8Array(3);
  private noiseCounter = 0;
  private noiseClockOutput = 0;
  private noiseOutput = 0;
  private noiseLfsr = 0;
  private cycleFraction = 0;

  private dcBlocking = true;
  private dcAlpha: number;
  private dcPrevious = 0;
  private dcOutput = 0;

  // Resampler anti-aliasing mode. Core default is 'none' (deterministic
  // point-sampling for conformance tests); the app sets it from the user's
  // Sound-panel choice (see applySettings in the owning machine).
  antialias: Sn76489AntialiasMode = 'none';

  // One-pole low-pass state for the 'lowpass' anti-alias mode.
  private lpAlpha: number;
  private lpOutput = 0;

  /** Tone-channel stereo placement (see Sn76489StereoMode). */
  private stereoMode: Sn76489StereoMode = 'MONO';
  private pan = panWeights('MONO');
  /** Per-side AC-coupling and low-pass state for the stereo path. */
  private readonly dcPrevLR = new Float64Array(2);
  private readonly dcOutLR = new Float64Array(2);
  private readonly lpOutLR = new Float64Array(2);
  private readonly stereoOut: StereoPsgSample = { left: 0, right: 0 };

  // 'mute' anti-alias threshold: any tone period at or above this value
  // produces a frequency at or above Nyquist for the current sample rate —
  // still ultrasonic on real hardware, but aliasing down into the audible
  // band if naively point-sampled. Recomputed whenever clockHz/sampleRate
  // change (see recomputeMuteThreshold). A tone toggles once per
  // `effectiveTonePeriod` internal (clock/16) ticks, so its full period is
  // 32*N ticks of the input clock — see generateSample().
  private muteThresholdPeriod = 1;

  constructor(
    public readonly clockHz: number,
    public sampleRate: number,
    public readonly variant: Sn76489Variant = 'ti-15bit',
  ) {
    this.dcAlpha = this.dcCoefficient(sampleRate);
    this.lpAlpha = this.lpCoefficient(sampleRate);
    this.recomputeMuteThreshold();
    this.reset();
  }

  setSampleRate(sampleRate: number): void {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) return;
    this.sampleRate = sampleRate;
    this.dcAlpha = this.dcCoefficient(sampleRate);
    this.lpAlpha = this.lpCoefficient(sampleRate);
    this.recomputeMuteThreshold();
    this.cycleFraction = 0;
  }

  /** Recompute the 'mute' anti-alias period threshold for the current
   *  clockHz/sampleRate — see muteThresholdPeriod. */
  private recomputeMuteThreshold(): void {
    this.muteThresholdPeriod = Math.floor(this.clockHz / (16 * this.sampleRate));
  }

  setStereoMode(mode: Sn76489StereoMode): void {
    if (mode === this.stereoMode) return;
    this.stereoMode = mode;
    this.pan = panWeights(mode);
    this.dcPrevLR.fill(0);
    this.dcOutLR.fill(0);
    this.lpOutLR.fill(0);
  }

  /** Disable only for deterministic raw-waveform conformance tests. */
  setDcBlocking(enabled: boolean): void {
    this.dcBlocking = enabled;
    this.dcPrevious = 0;
    this.dcOutput = 0;
  }

  reset(): void {
    this.tonePeriod.fill(0);
    this.attenuation.fill(15);
    this.toneCounter.fill(0x400);
    this.toneOutput.fill(0);
    this.noiseControl = 0;
    this.latchedRegister = 0;
    this.noiseCounter = 0x10;
    this.noiseClockOutput = 0;
    this.noiseOutput = 0;
    this.noiseLfsr = this.noiseResetValue();
    this.cycleFraction = 0;
    this.dcPrevious = 0;
    this.dcOutput = 0;
    this.lpOutput = 0;
    this.dcPrevLR.fill(0);
    this.dcOutLR.fill(0);
    this.lpOutLR.fill(0);
  }

  /** Write one byte to the PSG data bus. */
  write(value: number): void {
    value &= 0xFF;

    if (value & 0x80) {
      this.latchedRegister = (value >> 4) & 7;
      this.writeLatchedData(value & 0x0F, true);
      return;
    }

    // Data-only bytes update whichever register was most recently latched.
    if ((this.latchedRegister & 1) === 0 && this.latchedRegister < 6) {
      const channel = this.latchedRegister >> 1;
      this.tonePeriod[channel] =
        (this.tonePeriod[channel] & 0x00F) | ((value & 0x3F) << 4);
      // No counter reload: the running divider finishes its current count
      // and only picks up the new period when it next reaches zero.
    } else {
      this.writeLatchedData(value & 0x0F, false);
    }
  }

  /** Signed output of tone channel `channel` (±its volume). */
  private toneLevel(channel: number): number {
    const level = SN76489_VOLUME_TABLE[this.attenuation[channel]];
    // 'mute' anti-alias: a tone at or above Nyquist for the current sample
    // rate (see muteThresholdPeriod) is ultrasonic and inaudible on real
    // hardware. Force the tone gate high so the channel contributes a
    // steady level (DC, removed by AC coupling) instead of a tone that
    // would alias down into an audible whine. This only reshapes the
    // output stage — the tone/noise generators still clock at full rate,
    // so noise-mode-3's sync off channel 2 is unaffected.
    const ultrasonic = this.antialias === 'mute'
      && this.effectiveTonePeriod(channel) <= this.muteThresholdPeriod;
    const toneOut = ultrasonic ? 1 : this.toneOutput[channel];
    return toneOut ? level : -level;
  }

  private noiseLevel(): number {
    const level = SN76489_VOLUME_TABLE[this.attenuation[3]];
    return this.noiseOutput ? level : -level;
  }

  /** Current mono output before AC coupling, normalised to approximately ±1. */
  rawSample(): number {
    let mixed = 0;
    for (let channel = 0; channel < 3; channel++) mixed += this.toneLevel(channel);
    mixed += this.noiseLevel();
    return mixed * 0.25;
  }

  /** Current stereo output before AC coupling, into `stereoOut`. Each side
   *  sums to at most two full channels (hard + half centre + half noise), so
   *  halving keeps it at approximately ±1 like the mono mix. */
  private rawStereo(out: StereoPsgSample): void {
    const noiseHalf = this.noiseLevel() * 0.5;
    let l = noiseHalf, r = noiseHalf;
    for (let channel = 0; channel < 3; channel++) {
      const v = this.toneLevel(channel);
      l += v * this.pan.left[channel];
      r += v * this.pan.right[channel];
    }
    out.left = l * 0.5;
    out.right = r * 0.5;
  }

  /** Advance the chip by one host audio sample and return mono output. */
  generateSample(): number {
    // The SN76489AN divides its input clock by 16 before the programmable
    // tone/noise dividers. A tone output toggles after N internal ticks,
    // therefore its complete period is clock / (32*N).
    this.cycleFraction += this.clockHz / (this.sampleRate * 16);
    const ticks = Math.floor(this.cycleFraction);
    this.cycleFraction -= ticks;

    let raw: number;
    if (this.antialias === 'box' && ticks > 0) {
      // Average the chip output across every clock in this output sample
      // (box-filter decimation) — anti-aliases content near the sample
      // rate, so ultrasonic tones collapse to ~DC instead of aliasing to a
      // whine. Mirrors AY3891x.generateSample's 'box' path.
      let acc = 0;
      for (let i = 0; i < ticks; i++) {
        this.advanceTicks(1);
        acc += this.rawSample();
      }
      raw = acc / ticks;
    } else {
      if (ticks > 0) this.advanceTicks(ticks);
      raw = this.rawSample();
    }

    if (this.dcBlocking) {
      this.dcOutput = this.dcAlpha * (this.dcOutput + raw - this.dcPrevious);
      this.dcPrevious = raw;
      raw = this.dcOutput;
    }
    if (this.antialias === 'lowpass') {
      this.lpOutput += this.lpAlpha * (raw - this.lpOutput);
      raw = this.lpOutput;
    }
    return raw;
  }

  /** Advance by one host sample and return left/right output. In 'MONO' (the
   *  hardware) the mono output is duplicated; otherwise the tone channels are
   *  panned per the stereo mode, each side AC-coupled and filtered on its own. */
  generateSampleStereo(): StereoPsgSample {
    const out = this.stereoOut;
    if (this.stereoMode === 'MONO') {
      const sample = this.generateSample();
      out.left = sample;
      out.right = sample;
      return out;
    }

    this.cycleFraction += this.clockHz / (this.sampleRate * 16);
    const ticks = Math.floor(this.cycleFraction);
    this.cycleFraction -= ticks;

    let l: number, r: number;
    if (this.antialias === 'box' && ticks > 0) {
      let accL = 0, accR = 0;
      for (let i = 0; i < ticks; i++) {
        this.advanceTicks(1);
        this.rawStereo(out);
        accL += out.left;
        accR += out.right;
      }
      l = accL / ticks;
      r = accR / ticks;
    } else {
      if (ticks > 0) this.advanceTicks(ticks);
      this.rawStereo(out);
      l = out.left;
      r = out.right;
    }

    if (this.dcBlocking) {
      this.dcOutLR[0] = this.dcAlpha * (this.dcOutLR[0] + l - this.dcPrevLR[0]);
      this.dcPrevLR[0] = l;
      l = this.dcOutLR[0];
      this.dcOutLR[1] = this.dcAlpha * (this.dcOutLR[1] + r - this.dcPrevLR[1]);
      this.dcPrevLR[1] = r;
      r = this.dcOutLR[1];
    }
    if (this.antialias === 'lowpass') {
      this.lpOutLR[0] += this.lpAlpha * (l - this.lpOutLR[0]);
      this.lpOutLR[1] += this.lpAlpha * (r - this.lpOutLR[1]);
      l = this.lpOutLR[0];
      r = this.lpOutLR[1];
    }
    out.left = l;
    out.right = r;
    return out;
  }

  private advanceTicks(ticks: number): void {
    for (let channel = 0; channel < 3; channel++) {
      if (this.toneIsConstant(channel)) {
        this.toneOutput[channel] = 1;
        this.toneCounter[channel] = 1;
        continue;
      }

      let remaining = ticks;
      while (remaining >= this.toneCounter[channel]) {
        remaining -= this.toneCounter[channel];
        this.toneOutput[channel] ^= 1;
        if (
          channel === 2 &&
          (this.noiseControl & 3) === 3 &&
          this.toneOutput[channel] === 1
        ) {
          this.shiftNoise();
        }
        this.toneCounter[channel] = this.effectiveTonePeriod(channel);
      }
      this.toneCounter[channel] -= remaining;
    }

    // Rates 0-2 use an internal divider. The LFSR is clocked only on its
    // rising edge; rate 3 is instead clocked by tone channel 2 above.
    if ((this.noiseControl & 3) === 3) return;
    let noiseTicks = ticks;
    while (noiseTicks >= this.noiseCounter) {
      noiseTicks -= this.noiseCounter;
      this.noiseClockOutput ^= 1;
      if (this.noiseClockOutput === 1) this.shiftNoise();
      this.noiseCounter = this.fixedNoisePeriod();
    }
    this.noiseCounter -= noiseTicks;
  }

  private shiftNoise(): void {
    const white = (this.noiseControl & 4) !== 0;
    let feedback: number;
    if (!white) {
      feedback = this.noiseLfsr & 1;
    } else if (this.variant === 'ti-15bit') {
      feedback = (this.noiseLfsr ^ (this.noiseLfsr >> 1)) & 1;
    } else {
      // Sega's integrated PSG and MEMU's measured MTX model use taps 0 and 3.
      feedback = (this.noiseLfsr ^ (this.noiseLfsr >> 3)) & 1;
    }
    const highBit = this.variant === 'ti-15bit' ? 14 : 15;
    const mask = this.variant === 'ti-15bit' ? 0x7FFF : 0xFFFF;
    this.noiseLfsr = ((this.noiseLfsr >> 1) | (feedback << highBit)) & mask;
    if (this.noiseLfsr === 0) this.noiseLfsr = this.noiseResetValue();
    this.noiseOutput = this.noiseLfsr & 1;
  }

  private fixedNoisePeriod(): number {
    switch (this.noiseControl & 3) {
      case 0: return 0x10;
      case 1: return 0x20;
      case 2: return 0x40;
      default: return 1;
    }
  }

  private effectiveTonePeriod(channel: number): number {
    // The discrete TI parts (SN76489AN, and MEMU's MTX model) treat a
    // programmed zero as a 0x400 period — the 10-bit counter wraps.
    if (this.variant !== 'sega' && this.tonePeriod[channel] === 0) return 0x400;
    return Math.max(this.tonePeriod[channel], 1);
  }

  /** Sega's integrated PSG holds the tone output high for periods 0 and 1
   *  (used for PCM playback); the discrete TI chips keep toggling. */
  private toneIsConstant(channel: number): boolean {
    return this.variant === 'sega' && this.tonePeriod[channel] <= 1;
  }

  private noiseResetValue(): number {
    return this.variant === 'ti-15bit' ? 0x4000 : 0x8000;
  }

  private resetNoise(): void {
    this.noiseLfsr = this.noiseResetValue();
    this.noiseClockOutput = 0;
    this.noiseOutput = 0;
    this.noiseCounter = this.fixedNoisePeriod();
  }

  private writeLatchedData(data: number, latchByte: boolean): void {
    if ((this.latchedRegister & 1) !== 0) {
      this.attenuation[this.latchedRegister >> 1] = data & 0x0F;
      return;
    }
    if (this.latchedRegister === 6) {
      this.noiseControl = data & 7;
      this.resetNoise();
      return;
    }
    if (latchByte) {
      const channel = this.latchedRegister >> 1;
      this.tonePeriod[channel] =
        (this.tonePeriod[channel] & 0x3F0) | (data & 0x0F);
    }
  }

  private dcCoefficient(sampleRate: number): number {
    return 1 - (2 * Math.PI * 20 / sampleRate);
  }

  private lpCoefficient(sampleRate: number): number {
    return 1 - Math.exp(-2 * Math.PI * LP_CUTOFF_HZ / sampleRate);
  }
}
