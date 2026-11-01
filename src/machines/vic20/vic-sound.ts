/**
 * The VIC's sound: three square-wave voices an octave apart, a noise voice
 * and a 4-bit master volume, all from the VIC's registers ($900A-$900E).
 *
 *   $900A bass, $900B alto, $900C soprano, $900D noise:
 *         bit 7 on, bits 0-6 the frequency value X
 *   $900E bits 0-3 volume
 *
 * Each voice divides the CPU clock by its prescaler (bass 16, alto 8,
 * soprano 4) and then by a 7-bit counter that runs from X up to 127, so it
 * steps every 128 - X prescaled clocks. Each step shifts an 8-bit register
 * that feeds back its inverted top bit (a Johnson counter): sixteen steps
 * make one cycle of a square wave. The tone is therefore
 *
 *   f = clock / (256 >> voice) / (128 - X)       (voice 0 bass … 2 soprano)
 *
 * which is the Programmer's Reference Guide's formula (its 4329 / 8659 /
 * 17320 Hz constants on PAL are the clock over 256, 128 and 64), counting
 * 128 - X steps where the Guide prints 127 - X. A voice switched off shifts
 * in zeros and falls silent within a period.
 *
 * The noise voice steps a 16-bit linear-feedback shift register at the
 * Guide's noise rate (clock / 32 / (128 - X), twice per output cycle) and
 * sounds its low bit. The real chip's noise sequence and its exact clocking
 * have not been measured here.
 *
 * The output is the voices summed and scaled by the volume, with a level
 * that the volume alone sets: writing the volume register makes a sound by
 * itself, which is how the VIC-20's sampled-speech players work.
 *
 * Run lazily, like the SID: `advanceTo(t)` clocks it to the machine's cycle
 * `t` and queues output samples, which the mixer takes one at a time with
 * `generateSampleStereo`.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

const SAMPLE_BUFFER = 8192;

export class VicSound {
  /** Clocks run so far. */
  now = 0;
  /** Queue output samples while clocking (false in turbo). */
  audible = true;

  /** Each voice's counter and shift register, and the noise LFSR. */
  private readonly counter = new Uint8Array(4);
  private readonly shift = new Uint8Array(4);
  private lfsr = 0xFFFF;
  /** Cycles since reset, for the prescalers. */
  private phase = 0;

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

  /** `regs` is the VIC's register file, read live. */
  constructor(private readonly regs: Uint8Array, private readonly clockHz: number) {
    this.cyclesPerSample = clockHz / this.sampleRate;
    this.sampleLeft = this.cyclesPerSample;
  }

  reset(): void {
    this.counter.fill(0);
    this.shift.fill(0);
    this.lfsr = 0xFFFF;
    this.phase = 0;
    this.flush();
  }

  setSampleRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.sampleRate = rate;
    this.cyclesPerSample = this.clockHz / rate;
    this.flush();
  }

  /** Whether voice `v` (0 bass … 3 noise) is sounding a 1 now. */
  voiceBit(v: number): number {
    if (v === 3) return (this.regs[13] & 0x80) !== 0 ? this.lfsr & 1 : 0;
    return this.shift[v] & 1;
  }

  /** Step voice `v`'s divider once (a prescaled clock). */
  private stepVoice(v: number): void {
    const reg = this.regs[10 + v];
    const next = this.counter[v] + 1;
    if (next <= 127) { this.counter[v] = next; return; }
    this.counter[v] = reg & 0x7F;
    if (v === 3) {
      // Galois LFSR, taps 16, 14, 13, 11 (maximal length).
      const out = this.lfsr & 1;
      this.lfsr >>= 1;
      if (out) this.lfsr ^= 0xB400;
      return;
    }
    const s = this.shift[v];
    const feed = (reg & 0x80) !== 0 ? (~s >> 7) & 1 : 0;
    this.shift[v] = ((s << 1) | feed) & 0xFF;
  }

  /** The output level now: the voices summed, scaled by the volume, over a
   *  level the volume alone sets. 0..1. */
  private level(): number {
    const vol = this.regs[14] & 0x0F;
    if (vol === 0) return 0;
    const sum = (this.shift[0] & 1) + (this.shift[1] & 1) + (this.shift[2] & 1) + this.voiceBit(3);
    return (vol / 15) * (1 + sum) / 5;
  }

  /** Run the chip to cycle `t`. */
  advanceTo(t: number): void {
    let n = Math.floor(t - this.now);
    if (n <= 0) return;
    this.now += n;
    while (n > 0) {
      // The prescalers: soprano every 4 clocks, alto every 8, bass and the
      // noise every 16.
      const p = this.phase;
      if ((p & 3) === 0) {
        this.stepVoice(2);
        if ((p & 7) === 0) {
          this.stepVoice(1);
          if ((p & 15) === 0) { this.stepVoice(0); this.stepVoice(3); }
        }
      }
      this.phase = (p + 1) & 0xFFFF;
      n--;
      if (!this.audible) continue;
      this.sum += this.level();
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
    w.raw(this.counter); w.raw(this.shift);
    w.u16(this.lfsr); w.u16(this.phase);
    w.f64(this.now);
  }

  loadState(r: StateReader): void {
    r.rawInto(this.counter); r.rawInto(this.shift);
    this.lfsr = r.u16(); this.phase = r.u16();
    this.now = r.f64();
    this.flush();
  }
}
