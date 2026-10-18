/**
 * Dave — the Enterprise's sound, timer and interrupt chip.
 *
 * Sound: three tone channels (12-bit dividers, each of which can be distorted
 * through a 4/5/7-bit polynomial counter, high-pass filtered by its neighbour
 * and ring-modulated) and a noise channel clocked from a 31.25kHz oscillator
 * or one of the tones, with 6-bit left and right volumes per channel and a
 * DAC mode that turns channel 0's volumes into a sample output.
 *
 * Timers: a 1kHz/50Hz/tone-driven "sound" interrupt and a 1Hz interrupt,
 * plus two external inputs — INT1 is Nick's VINT, INT2 is unused here. Each
 * source has an enable and a latch (port 0xB4); the Z80's /INT is low while
 * any latch is set.
 *
 * Dave counts at 250kHz (its 8MHz input / 32; /48 when port 0xBF says the
 * input is 12MHz), which with the 4MHz Z80 is one tick per 16 T-states. The
 * channel network follows ep128emu's `dave.cpp`, the most complete public
 * description of the chip; the code is not derived from it.
 */

import type { StereoAudioSource } from '@/machines/shared/audio-mixer.ts';

/** A maximal-length polynomial counter's output sequence, read backwards as
 *  Dave's counters run: `bits` long, taps at `tap` and the top bit. */
function polyTable(bits: number, tap: number): Uint8Array {
  const top = 1 << (bits - 1);
  const second = 1 << (tap - 1);
  const len = (1 << bits) - 1;
  const out = new Uint8Array(len);
  let sr = 0xFFFFFFFF;
  for (let n = len - 1; n >= 0; n--) {
    const b0 = (sr & top) ? 1 : 0;
    const b1 = (sr & second) ? 1 : 0;
    out[n] = b0;
    sr = ((sr << 1) | (b0 ^ b1)) >>> 0;
  }
  return out;
}

const POLY4 = polyTable(4, 3);
const POLY5 = polyTable(5, 3);
const POLY7 = polyTable(7, 6);
const POLY9 = polyTable(9, 5);
const POLY11 = polyTable(11, 9);
const POLY15 = polyTable(15, 14);
const POLY17 = polyTable(17, 14);

/** Tone distortion source (port 0xA1/A3/A5 bits 5-4). */
const SRC_SQUARE = 0, SRC_POLY4 = 1, SRC_POLY5 = 2, SRC_POLY7 = 3;

/** Peak level of one Dave output: four channels of 63 plus tape feedback. */
const FULL_SCALE = 4 * 63;

export class Dave implements StereoAudioSource {
  // ── Polynomial counters ─────────────────────────────────────────────────
  private p4 = 0; private p5 = 0; private p7 = 0; private pVL = 0;
  private s4 = 0; private s5 = 0; private s7 = 0; private sVL = 0;
  private vlTable: Uint8Array = POLY17;
  /** Port 0xA6 bit 4: the noise channel takes the 7-bit counter and the
   *  tones' "7-bit" distortion takes the variable-length one instead. */
  private noiseIs7bit = false;

  // ── Timebase ────────────────────────────────────────────────────────────
  private clk31k = 0; private clk31kState = 0;
  private clk1k = 0; private clk50 = 0; private clk1 = 0;
  /** Dave ticks per Z80 T-state run so far, as a remainder. */
  private tRemainder = 0;
  /** T-states per Dave tick: 16, or 24 when port 0xBF bit 1 says 12MHz. */
  private tPerTick = 16;

  // ── Tone channels 0-2 ───────────────────────────────────────────────────
  private readonly freq = new Int32Array(3);
  private readonly phase = new Int32Array(3);
  private readonly run = new Uint8Array([1, 1, 1]);
  private readonly osc = new Uint8Array(3);
  private readonly src = new Uint8Array(3);
  private readonly highPass = new Uint8Array(3);
  private readonly ringMod = new Uint8Array(3);
  /** Channel outputs this tick and last tick, 0-3 (3 = noise). */
  private readonly out = new Uint8Array(4);
  private readonly prev = new Uint8Array(4);

  // ── Noise channel 3 ─────────────────────────────────────────────────────
  /** Port 0xA6 bits 1-0: 0 = 31.25kHz, 1-3 = tone channel 0-2's output. */
  private noiseClock = 0;
  private noiseClockPrev = 0;
  private noiseIn = 0;
  private noiseHeld = 0;
  private noiseLowPass = false;
  private noiseHighPass = false;
  private noiseRingMod = false;

  // ── Mixer ───────────────────────────────────────────────────────────────
  readonly left = new Uint8Array(4);
  readonly right = new Uint8Array(4);
  private dacLeft = false;
  private dacRight = false;
  private sumL = 0; private sumR = 0; private sumN = 0;
  private dcL = 0; private dcR = 0; private dcPrevL = 0; private dcPrevR = 0;
  /** Last sample produced (0..1 per side), for the sound activity LED. */
  level = 0;

  // ── Interrupts ──────────────────────────────────────────────────────────
  /** Port 0xA7 bits 6-5: the sound interrupt's source. */
  private sndSource = 0;
  private sndState = 0; private secState = 0; private int1State = 0; private int2State = 0;
  private sndEnable = false; private secEnable = false; private int1Enable = false; private int2Enable = false;
  private sndLatch = false; private secLatch = false; private int1Latch = false; private int2Latch = false;

  /** The Z80's /INT: low while any latch is set. */
  get irq(): boolean { return this.sndLatch || this.secLatch || this.int1Latch || this.int2Latch; }

  // ── Other Dave I/O ──────────────────────────────────────────────────────
  /** Port 0xB5 bits 3-0: keyboard row. */
  keyboardRow = 0;
  /** Port 0xB5 bits 7-6: cassette remote relays. */
  remote = 0;
  /** Port 0xBF bits 3-2: memory wait states (0 all, 1 M1 only, 2/3 none). */
  waitMode = 0;

  /** Raised when port 0xBF changes the wait mode. */
  onWaitModeChange: ((mode: number) => void) | null = null;

  reset(): void {
    this.p4 = this.p5 = this.p7 = this.pVL = 0;
    this.s4 = this.s5 = this.s7 = this.sVL = 0;
    this.clk31k = this.clk31kState = 0;
    this.clk1k = this.clk50 = this.clk1 = 0;
    this.tRemainder = 0;
    this.phase.fill(0);
    this.osc.fill(0);
    this.out.fill(0);
    this.prev.fill(0);
    this.noiseClockPrev = this.noiseIn = this.noiseHeld = 0;
    this.sumL = this.sumR = this.sumN = 0;
    this.dcL = this.dcR = this.dcPrevL = this.dcPrevR = 0;
    this.level = 0;
    this.sndState = this.secState = 0;
    this.int1State = this.int2State = 1;
    for (let r = 0; r < 0x20; r++) this.write(r, 0);
    this.write(0x14, 0xAA);    // clear every latch
  }

  /** A write to Dave's register `reg` (port 0xA0 + reg). Paging (0x10-0x13)
   *  is handled by the machine; everything else lands here. */
  write(reg: number, value: number): void {
    switch (reg & 0x1F) {
      case 0x00: case 0x02: case 0x04: {
        const ch = reg >> 1;
        this.freq[ch] = (this.freq[ch] & 0xF00) | value;
        break;
      }
      case 0x01: case 0x03: case 0x05: {
        const ch = reg >> 1;
        this.freq[ch] = (this.freq[ch] & 0xFF) | ((value & 0x0F) << 8);
        this.src[ch] = (value >> 4) & 3;
        this.highPass[ch] = (value >> 6) & 1;
        this.ringMod[ch] = (value >> 7) & 1;
        break;
      }
      case 0x06: {
        this.noiseClock = value & 3;
        const vl = (value >> 2) & 3;
        this.vlTable = vl === 0 ? POLY17 : vl === 1 ? POLY15 : vl === 2 ? POLY11 : POLY9;
        this.pVL %= this.vlTable.length;
        this.noiseIs7bit = (value & 0x10) !== 0;
        this.noiseLowPass = (value & 0x20) !== 0;
        this.noiseHighPass = (value & 0x40) !== 0;
        this.noiseRingMod = (value & 0x80) !== 0;
        break;
      }
      case 0x07:
        // Bits 0-2 hold a tone channel in sync (stopped, output low); on
        // release it restarts from a full period.
        for (let ch = 0; ch < 3; ch++) {
          if (value & (1 << ch)) { this.run[ch] = 0; this.osc[ch] = 0; }
          else if (!this.run[ch]) { this.phase[ch] = this.freq[ch]; this.run[ch] = 1; }
        }
        this.dacLeft = (value & 0x08) !== 0;
        this.dacRight = (value & 0x10) !== 0;
        this.sndSource = (value >> 5) & 3;
        break;
      case 0x08: case 0x09: case 0x0A: case 0x0B:
        this.left[reg & 3] = value & 0x3F;
        break;
      case 0x0C: case 0x0D: case 0x0E: case 0x0F:
        this.right[reg & 3] = value & 0x3F;
        break;
      case 0x14: {
        // Even bits enable a source, odd bits clear its latch. A disabled
        // source cannot hold its latch either.
        this.sndEnable = (value & 0x01) !== 0;
        if (!this.sndEnable || (value & 0x02)) this.sndLatch = false;
        this.secEnable = (value & 0x04) !== 0;
        if (!this.secEnable || (value & 0x08)) this.secLatch = false;
        this.int1Enable = (value & 0x10) !== 0;
        if (!this.int1Enable || (value & 0x20)) this.int1Latch = false;
        this.int2Enable = (value & 0x40) !== 0;
        if (!this.int2Enable || (value & 0x80)) this.int2Latch = false;
        break;
      }
      case 0x15:
        this.keyboardRow = value & 0x0F;
        this.remote = (value >> 6) & 3;
        break;
      case 0x1F: {
        this.tPerTick = (value & 0x02) ? 24 : 16;
        const mode = (value >> 2) & 3;
        if (mode !== this.waitMode) {
          this.waitMode = mode;
          this.onWaitModeChange?.(mode);
        }
        break;
      }
    }
  }

  /** Port 0xB4: each source's current state in the even bit and its latch
   *  in the odd one. */
  readInterrupts(): number {
    return (this.sndState | (this.sndLatch ? 2 : 0))
      | ((this.secState | (this.secLatch ? 2 : 0)) << 2)
      | ((this.int1State | (this.int1Latch ? 2 : 0)) << 4)
      | ((this.int2State | (this.int2Latch ? 2 : 0)) << 6);
  }

  /** INT1 (Nick's VINT). Dave latches the falling edge of its input — the
   *  line goes low at the end of a block that had VINT set. */
  setInt1(high: boolean): void {
    const prev = this.int1State;
    this.int1State = high ? 1 : 0;
    if (this.int1Enable && prev && !high) this.int1Latch = true;
  }

  /** Advance Dave by `t` Z80 T-states. `mixAudio` false skips sample
   *  accumulation (turbo) but keeps the timers and interrupts running. */
  advance(t: number, mixAudio: boolean): void {
    this.tRemainder += t;
    const per = this.tPerTick;
    while (this.tRemainder >= per) {
      this.tRemainder -= per;
      this.tick(mixAudio);
    }
  }

  /** One 250kHz Dave cycle. */
  private tick(mixAudio: boolean): void {
    // Polynomial counters run free; whichever one the noise channel uses is
    // instead clocked by the noise channel's clock source (below).
    if (--this.p4 < 0) this.p4 = POLY4.length - 1;
    this.s4 = POLY4[this.p4];
    if (--this.p5 < 0) this.p5 = POLY5.length - 1;
    this.s5 = POLY5[this.p5];
    const clockSrc = this.noiseClock === 0 ? this.clk31kState : this.out[this.noiseClock - 1];
    const noiseEdge = clockSrc < this.noiseClockPrev;
    this.noiseClockPrev = clockSrc;
    if (!this.noiseIs7bit) {
      if (--this.p7 < 0) this.p7 = POLY7.length - 1;
      this.s7 = POLY7[this.p7];
      if (noiseEdge) {
        if (--this.pVL < 0) this.pVL = this.vlTable.length - 1;
        this.sVL = this.vlTable[this.pVL];
        this.noiseIn = this.sVL;
        if (!this.noiseLowPass) this.noiseHeld = this.sVL;
      }
    } else {
      if (noiseEdge) {
        if (--this.p7 < 0) this.p7 = POLY7.length - 1;
        this.s7 = POLY7[this.p7];
        this.noiseIn = this.s7;
        if (!this.noiseLowPass) this.noiseHeld = this.s7;
      }
      if (--this.pVL < 0) this.pVL = this.vlTable.length - 1;
      this.sVL = this.vlTable[this.pVL];
    }

    // Timebase and the tone dividers.
    this.clk31k--;
    this.clk1k--;
    for (let ch = 0; ch < 3; ch++) this.phase[ch] -= this.run[ch];

    // The sound interrupt's source is read before anything reloads: the 1kHz
    // or 50Hz divider, or a tone channel's divider, running out.
    const kHz = this.clk1k < 0;
    if (kHz) this.clk50--;
    const src = this.sndSource;
    const sndEvent = src === 0 ? kHz : src === 1 ? kHz && this.clk50 < 0 : this.phase[src - 2] < 0;
    if (kHz) {
      this.clk1k = 249;
      if (this.clk50 < 0) {
        this.clk50 = 19;
        if (--this.clk1 < 0) {
          this.clk1 = 49;
          this.secState ^= 1;
          if (this.secEnable) this.secLatch = true;
        }
      }
    }
    if (sndEvent) {
      this.sndState ^= 1;
      if (this.sndEnable) this.sndLatch = true;
    }
    if (this.clk31k < 0) { this.clk31k = 3; this.clk31kState ^= 1; }

    // The channel network, evaluated 3, 2, 1, 0 so each filter and ring
    // modulator sees its source channel's state as ep128emu orders them.
    const out = this.out, prev = this.prev;
    prev[3] = out[3];
    if (this.noiseLowPass && out[2] < prev[2]) this.noiseHeld = this.noiseIn;
    if (this.noiseHighPass && out[0] < prev[0]) this.noiseHeld = 0;
    out[3] = this.noiseRingMod ? this.noiseHeld ^ (out[1] ^ 1) : this.noiseHeld;

    this.toneChannel(2, 3, 0);
    this.toneChannel(1, 2, 3);
    this.toneChannel(0, 1, 2);

    if (!mixAudio) return;
    let l = 0, r = 0;
    if (this.dacLeft) l = this.left[0] << 2;
    else for (let ch = 0; ch < 4; ch++) if (out[ch]) l += this.left[ch];
    if (this.dacRight) r = this.right[0] << 2;
    else for (let ch = 0; ch < 4; ch++) if (out[ch]) r += this.right[ch];
    this.sumL += l;
    this.sumR += r;
    this.sumN++;
  }

  /** Tone channel `ch`: its divider, distortion, a high-pass reset on the
   *  falling edge of channel `hpFrom` and ring modulation by `rmFrom`. */
  private toneChannel(ch: number, hpFrom: number, rmFrom: number): void {
    const out = this.out, prev = this.prev;
    prev[ch] = out[ch];
    if (this.phase[ch] < 0) {
      this.phase[ch] = this.freq[ch];
      switch (this.src[ch]) {
        case SRC_SQUARE: this.osc[ch] ^= 1; break;
        case SRC_POLY4: this.osc[ch] = this.s4; break;
        case SRC_POLY5: this.osc[ch] = this.s5; break;
        case SRC_POLY7: this.osc[ch] = this.noiseIs7bit ? this.sVL : this.s7; break;
      }
    }
    if (this.highPass[ch] && out[hpFrom] < prev[hpFrom]) this.osc[ch] = 0;
    out[ch] = this.ringMod[ch] ? this.osc[ch] ^ (out[rmFrom] ^ 1) : this.osc[ch];
  }

  /** The mixer's PSG hook: the average output since the last sample, DC
   *  blocked so a parked channel at full volume does not hold a level. */
  generateSampleStereo(): { left: number; right: number } {
    const n = this.sumN || 1;
    const l = this.sumL / (n * FULL_SCALE);
    const r = this.sumR / (n * FULL_SCALE);
    this.sumL = this.sumR = this.sumN = 0;
    this.dcL = 0.995 * (this.dcL + l - this.dcPrevL);
    this.dcR = 0.995 * (this.dcR + r - this.dcPrevR);
    this.dcPrevL = l;
    this.dcPrevR = r;
    this.level = l > r ? l : r;
    return { left: this.dcL, right: this.dcR };
  }

  /** The mixer's sample-rate hook — Dave's averaging needs nothing. */
  setSampleRate(_rate: number): void { /* sample-rate independent */ }
}
