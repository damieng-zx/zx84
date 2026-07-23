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

export interface StereoPsgSample {
  left: number;
  right: number;
}

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

  constructor(
    public readonly clockHz: number,
    public sampleRate: number,
    public readonly variant: Sn76489Variant = 'ti-15bit',
  ) {
    this.dcAlpha = this.dcCoefficient(sampleRate);
    this.reset();
  }

  setSampleRate(sampleRate: number): void {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) return;
    this.sampleRate = sampleRate;
    this.dcAlpha = this.dcCoefficient(sampleRate);
    this.cycleFraction = 0;
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
      this.reloadToneCounter(channel);
    } else {
      this.writeLatchedData(value & 0x0F, false);
    }
  }

  /** Current mono output before AC coupling, normalised to approximately ±1. */
  rawSample(): number {
    let mixed = 0;
    for (let channel = 0; channel < 3; channel++) {
      const level = SN76489_VOLUME_TABLE[this.attenuation[channel]];
      mixed += this.toneOutput[channel] ? level : -level;
    }
    const noiseLevel = SN76489_VOLUME_TABLE[this.attenuation[3]];
    mixed += this.noiseOutput ? noiseLevel : -noiseLevel;
    return mixed * 0.25;
  }

  /** Advance the chip by one host audio sample and return mono output. */
  generateSample(): number {
    // The SN76489AN divides its input clock by 16 before the programmable
    // tone/noise dividers. A tone output toggles after N internal ticks,
    // therefore its complete period is clock / (32*N).
    this.cycleFraction += this.clockHz / (this.sampleRate * 16);
    const ticks = Math.floor(this.cycleFraction);
    this.cycleFraction -= ticks;
    if (ticks > 0) this.advanceTicks(ticks);

    const raw = this.rawSample();
    if (!this.dcBlocking) return raw;
    this.dcOutput = this.dcAlpha * (this.dcOutput + raw - this.dcPrevious);
    this.dcPrevious = raw;
    return this.dcOutput;
  }

  /** The physical chip is mono; duplicate its output for the stereo mixer. */
  generateSampleStereo(): StereoPsgSample {
    const sample = this.generateSample();
    return { left: sample, right: sample };
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
    // MEMU models the MTX's programmed zero as the undocumented 0x400 period.
    if (this.variant === 'mtx' && this.tonePeriod[channel] === 0) return 0x400;
    return Math.max(this.tonePeriod[channel], 1);
  }

  private toneIsConstant(channel: number): boolean {
    return this.variant !== 'mtx' && this.tonePeriod[channel] <= 1;
  }

  private reloadToneCounter(channel: number): void {
    this.toneCounter[channel] = this.effectiveTonePeriod(channel);
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
      this.reloadToneCounter(channel);
    }
  }

  private dcCoefficient(sampleRate: number): number {
    return 1 - (2 * Math.PI * 20 / sampleRate);
  }
}
