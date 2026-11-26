/**
 * The TED's sound: two square-wave voices and a noise channel, with a 4-bit
 * volume, all from registers `$FF0E-$FF12`.
 *
 *   $FF0E  voice 1 frequency, low 8 bits
 *   $FF0F  voice 2 frequency, low 8 bits
 *   $FF10  bits 0-1  voice 2 frequency, bits 8-9
 *   $FF11  bits 0-3 volume (8-15 are the same as 8); bit 4 voice 1 on;
 *          bit 5 voice 2 on; bit 6 noise on voice 2; bit 7 the D/A mode
 *   $FF12  bits 0-1  voice 1 frequency, bits 8-9
 *
 * A voice's frequency is ten bits; the oscillator divides the clock by eight
 * and then by `frequency + 1` for each half of the square wave, so
 *
 *   f = clock / 8 / (2 * (frequency + 1))
 *
 * A frequency of `$3FE` (and above) is silence: the chip holds the output at
 * one level, which programs use to gate a voice without touching the control
 * register.
 *
 * The noise is a shift register clocked by voice 2, tapping
 * `x^8 + x^5 + x^4 + x^1 + 1` (VICE's: bits 7, 5, 4 and 1 XORed into the
 * input).
 *
 * In the D/A mode (bit 7) the volume register itself is played as a sample:
 * the KERNAL's sampled-speech players on the Plus/4 work that way.
 *
 * Run lazily, like the SID and the VIC: `advanceTo(t)` clocks the chip to the
 * machine's cycle `t` and queues output samples, which the mixer takes one at
 * a time.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

const SAMPLE_BUFFER = 8192;

/** The volume a value of 8-15 gives. */
function volumeOf(reg: number): number {
  const v = reg & 0x0F;
  return Math.min(v, 8) / 8;
}

export class TedSound {
  /** The TED's register file, read live. */
  constructor(private readonly regs: Uint8Array, private readonly clockHz: number) {
    this.cyclesPerSample = clockHz / this.sampleRate;
    this.sampleLeft = this.cyclesPerSample;
  }

  /** Clocks run so far (the TED's cycle count). */
  now = 0;
  /** Queue output samples while clocking (false in turbo). */
  audible = true;

  /** Each voice's accumulator: cycles of the divided clock at its frequency. */
  private accu0 = 0;
  private accu1 = 0;
  /** The square-wave levels the two voices are at (0 or 1). */
  private level0 = 0;
  private level1 = 0;
  /** The noise shift register. */
  private noise = 0xFF;

  private sampleRate = 44100;
  private cyclesPerSample: number;
  private sampleLeft: number;
  private sum = 0;
  private sumCount = 0;
  private readonly samples = new Float32Array(SAMPLE_BUFFER);
  private sampleHead = 0;
  private sampleCount = 0;
  private lastSample = 0;
  private readonly lastOut = { left: 0, right: 0 };

  private setSampleRateValue(rate: number): void {
    this.sampleRate = rate;
    this.cyclesPerSample = this.clockHz / rate;
    this.flush();
  }

  setSampleRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.setSampleRateValue(rate);
  }

  reset(): void {
    this.accu0 = 0; this.accu1 = 0;
    this.level0 = 0; this.level1 = 0;
    this.noise = 0xFF;
    this.flush();
  }

  /** Bring the chip's clock to `t` without stepping it (after a reset or a
   *  restore, where `now` came back in the state). */
  syncClocks(t: number): void {
    this.now = t;
    this.flush();
  }

  /** Voice 1's frequency, ten bits. */
  private get freq0(): number { return (this.regs[0x0E] | ((this.regs[0x12] & 0x03) << 8)) & 0x3FF; }
  /** Voice 2's frequency, ten bits. */
  private get freq1(): number { return (this.regs[0x0F] | ((this.regs[0x10] & 0x03) << 8)) & 0x3FF; }


  /** Step the oscillators by `n` CPU cycles and fold the result into the
   *  running sample sum. */
  private step(n: number): void {
    const control = this.regs[0x11];
    const digital = (control & 0x80) !== 0;
    if (digital) {
      // D/A mode: the volume register is the sample, held for as long as it is
      // written. The KERNAL's speech players set a volume and a timer.
      const level = volumeOf(control);
      for (let i = 0; i < n; i++) {
        if (!this.audible) continue;
        this.sum += level;
        this.sumCount++;
        if (--this.sampleLeft <= 0) {
          this.sampleLeft += this.cyclesPerSample;
          this.emit(this.sumCount > 0 ? this.sum / this.sumCount : 0);
          this.sum = 0;
          this.sumCount = 0;
        }
      }
      return;
    }
    const vo0 = (control & 0x10) !== 0;
    const vo1 = (control & 0x20) !== 0;
    const noiseOn = (control & 0x40) !== 0;
    const volume = volumeOf(control);
    const f0 = this.freq0;
    const f1 = this.freq1;
    // The oscillator clock is the CPU clock over eight, and each half-wave
    // lasts (frequency + 1) of its cycles: 8 × (frequency + 1) CPU cycles.
    const half0 = f0 >= 0x3FE ? 0 : (f0 + 1) * 8;
    const half1 = f1 >= 0x3FE ? 0 : (f1 + 1) * 8;

    for (let i = 0; i < n; i++) {
      if (half0 > 0) {
        if (++this.accu0 >= half0) { this.accu0 -= half0; this.level0 ^= 1; }
      }
      if (half1 > 0) {
        if (++this.accu1 >= half1) {
          this.accu1 -= half1;
          this.level1 ^= 1;
          // Voice 2 clocks the noise shift register.
          const bit = ((this.noise >> 7) ^ (this.noise >> 5) ^ (this.noise >> 4) ^ (this.noise >> 1)) & 1;
          this.noise = ((this.noise << 1) | bit) & 0xFF;
        }
      }
      if (!this.audible) continue;
      let level = 0;
      if (vo0) level += this.level0;
      if (vo1) level += this.level1;
      if (noiseOn) level += this.noise & 1;
      this.sum += (level / 3) * volume;
      this.sumCount++;
      if (--this.sampleLeft <= 0) {
        this.sampleLeft += this.cyclesPerSample;
        this.emit(this.sumCount > 0 ? this.sum / this.sumCount : 0);
        this.sum = 0;
        this.sumCount = 0;
      }
    }
  }

  private emit(v: number): void {
    if (this.sampleCount >= SAMPLE_BUFFER) return;
    this.samples[(this.sampleHead + this.sampleCount) % SAMPLE_BUFFER] = v;
    this.sampleCount++;
  }

  /** Run the chip to cycle `t`. */
  advanceTo(t: number): void {
    const n = Math.floor(t - this.now);
    if (n <= 0) return;
    this.now += n;
    this.step(n);
  }

  /** One output sample for the mixer (it repeats the last when none is queued). */
  generateSampleStereo(): { left: number; right: number } {
    if (this.sampleCount > 0) {
      this.lastSample = this.samples[this.sampleHead];
      this.sampleHead = (this.sampleHead + 1) % SAMPLE_BUFFER;
      this.sampleCount--;
    }
    this.lastOut.left = this.lastOut.right = this.lastSample;
    return this.lastOut;
  }

  /** Drop queued samples and the sample in progress (after turbo or a restore). */
  flush(): void {
    this.sampleCount = 0;
    this.sum = 0;
    this.sumCount = 0;
    this.sampleLeft = this.cyclesPerSample;
  }

  saveState(w: StateWriter): void {
    w.f64(this.accu0); w.f64(this.accu1);
    w.u8(this.level0); w.u8(this.level1); w.u8(this.noise);
    w.f64(this.now);
  }

  loadState(r: StateReader): void {
    this.accu0 = r.f64(); this.accu1 = r.f64();
    this.level0 = r.u8(); this.level1 = r.u8(); this.noise = r.u8();
    this.now = r.f64();
    this.flush();
  }
}
