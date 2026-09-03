/**
 * Philips SAA1099 — six-channel stereo sound generator.
 *
 * Commodity silicon: it shipped in the SAM Coupé, the Blue Alpha / SAM Mega
 * add-ons, and the PC "Game Blaster" / Creative Music System boards, so it
 * lives here rather than in a machine folder.
 *
 * Six tone channels, each with independent left and right amplitude, two noise
 * generators, and two envelope generators. On the SAM the chip is clocked at
 * 8 MHz (24 MHz / 3) and addressed through two ports that share a low byte:
 * 0x01FF selects a register, 0x00FF writes it (the chip's A0 is wired to Z80
 * A8 — easy to get backwards).
 *
 * ── Register map ──
 *
 *   0x00-0x05  Amplitude, channels 0-5. Bits 3-0 LEFT, bits 7-4 RIGHT.
 *   0x08-0x0D  Frequency, channels 0-5 (0x00-0xFF).
 *   0x10-0x12  Octave, packed two channels per byte: bits 2-0 the even
 *              channel, bits 6-4 the odd one.
 *   0x14       Tone enable, one bit per channel (bits 5-0).
 *   0x15       Noise enable, one bit per channel (bits 5-0).
 *   0x16       Noise generator rates: bits 1-0 for generator 0, bits 5-4 for
 *              generator 1.
 *   0x18/0x19  Envelope control for generators 0 (channels 0-2) and 1 (3-5).
 *   0x1C       Bit 0 enables all channels; bit 1 resets and synchronises the
 *              generators.
 *
 * ── Timing ──
 *
 * A channel's counter period in clock ticks is
 *
 *     divisor = (511 - frequency) << (8 - octave)
 *
 * and the output level toggles once per period, so the emitted square wave is
 *
 *     f = clock / (2 * divisor) = 15625 * 2^octave / (511 - frequency)  Hz
 *
 * at 8 MHz — the documented 31 Hz to 7.81 kHz range. Because the smallest
 * divisor (512) is larger than the number of clock ticks in one output sample
 * (~167 at 48 kHz), the inner stepping loop runs at most once per sample.
 *
 * Register semantics transcribed from MAME's `sound/saa1099.cpp` and the
 * Philips datasheet.
 */

/** Noise LFSR polynomial x^18 + x^11 + x. */
const NOISE_TAP_A = 0x20000;
const NOISE_TAP_B = 0x00400;

/** Envelope resolution: 16 steps at 4-bit, 8 at 3-bit. */
const ENV_STEPS = 16;

/**
 * The eight envelope shapes, as amplitude factors 0-15 across 16 steps.
 *
 * TODO(verify): the shapes themselves are the documented set (zero, maximum,
 * decay, triangular, attack, each in single and repeating form), but the exact
 * step-by-step curve and the point at which a "single" envelope latches off
 * have not been checked against hardware. Tone and noise generation — which is
 * what nearly all SAM software uses — do not depend on this table.
 */
const ENVELOPE_SHAPES: readonly (readonly number[])[] = (() => {
  const down = Array.from({ length: ENV_STEPS }, (_, i) => 15 - i);
  const up = Array.from({ length: ENV_STEPS }, (_, i) => i);
  const zero = Array.from({ length: ENV_STEPS }, () => 0);
  const max = Array.from({ length: ENV_STEPS }, () => 15);
  return [
    zero,   // 0: zero amplitude
    max,    // 1: maximum amplitude
    down,   // 2: single decay      (holds at 0 after one pass)
    down,   // 3: repetitive decay
    up.concat(down).filter((_, i) => i % 2 === 0),   // 4: single triangular
    up.concat(down).filter((_, i) => i % 2 === 0),   // 5: repetitive triangular
    up,     // 6: single attack     (holds at 0 after one pass)
    up,     // 7: repetitive attack
  ];
})();

/** Shapes 2, 4 and 6 run once and then stay silent until retriggered. */
const SINGLE_SHOT = [false, false, true, false, true, false, true, false];

interface Channel {
  /** Frequency register, 0x00-0xFF. */
  frequency: number;
  /** Octave, 0-7. */
  octave: number;
  toneEnabled: boolean;
  noiseEnabled: boolean;
  /** Amplitude 0-15 for [left, right]. */
  amplitude: [number, number];
  /** Down-counter in clock ticks; toggles `level` when it runs out. */
  counter: number;
  level: number;
}

interface Noise {
  counter: number;
  /** Period in clock ticks, or -1 when slaved to a tone generator. */
  period: number;
  /** Which tone channel drives it when rate 3 is selected. */
  slavedTo: number;
  lfsr: number;
}

interface Envelope {
  enabled: boolean;
  shape: number;
  /** True for 3-bit resolution (the LSB of the step is masked off). */
  threeBit: boolean;
  /** True when clocked externally by a write to the control register. */
  externalClock: boolean;
  /** True when the right channel mirrors the left. */
  reverseRight: boolean;
  step: number;
  /** Set once a single-shot shape has completed its pass. */
  finished: boolean;
}

export class SAA1099 {
  private chipClock: number;
  /** Chip clock ticks per output sample. */
  private ticksPerSample = 0;

  private readonly channels: Channel[] = [];
  private readonly noise: Noise[] = [];
  private readonly envelopes: Envelope[] = [];

  /** Register 0x1C bit 0 — with this clear the chip is silent. */
  private soundEnabled = false;
  /** Currently addressed register (written through the address port). */
  private address = 0;

  /** DC-blocking filter state, matching the AY core's ~20 Hz high pass. */
  private dcAlpha = 0;
  private dcPrevL = 0;
  private dcPrevR = 0;
  private dcOutL = 0;
  private dcOutR = 0;

  constructor(chipClock = 8_000_000, sampleRate = 44100) {
    this.chipClock = chipClock;
    for (let i = 0; i < 6; i++) {
      this.channels.push({
        frequency: 0, octave: 0, toneEnabled: false, noiseEnabled: false,
        amplitude: [0, 0], counter: 0, level: 0,
      });
    }
    for (let i = 0; i < 2; i++) {
      this.noise.push({ counter: 0, period: 256, slavedTo: -1, lfsr: 0xFFFFFFFF });
      this.envelopes.push({
        enabled: false, shape: 0, threeBit: false, externalClock: false,
        reverseRight: false, step: 0, finished: false,
      });
    }
    this.setSampleRate(sampleRate);
    this.reset();
  }

  setSampleRate(sampleRate: number): void {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) return;
    this.ticksPerSample = this.chipClock / sampleRate;
    this.dcAlpha = 1 - (2 * Math.PI * 20 / sampleRate);
  }

  reset(): void {
    for (const c of this.channels) {
      c.frequency = 0; c.octave = 0;
      c.toneEnabled = false; c.noiseEnabled = false;
      c.amplitude[0] = 0; c.amplitude[1] = 0;
      c.counter = 0; c.level = 0;
    }
    for (const n of this.noise) {
      n.counter = 0; n.period = 256; n.slavedTo = -1; n.lfsr = 0xFFFFFFFF;
    }
    for (const e of this.envelopes) {
      e.enabled = false; e.shape = 0; e.threeBit = false;
      e.externalClock = false; e.reverseRight = false;
      e.step = 0; e.finished = false;
    }
    this.soundEnabled = false;
    this.address = 0;
    this.dcPrevL = this.dcPrevR = this.dcOutL = this.dcOutR = 0;
  }

  // ── Bus interface ─────────────────────────────────────────────────────────

  /** Select a register (SAM port 0x01FF). */
  writeAddress(value: number): void { this.address = value & 0x1F; }

  /** Write the selected register (SAM port 0x00FF). */
  writeData(value: number): void { this.writeRegister(this.address, value); }

  /** Write a register directly, bypassing the address latch. */
  writeRegister(reg: number, value: number): void {
    const v = value & 0xFF;
    switch (reg & 0x1F) {
      case 0x00: case 0x01: case 0x02:
      case 0x03: case 0x04: case 0x05: {
        // Bits 3-0 are the LEFT amplitude, bits 7-4 the RIGHT.
        const c = this.channels[reg];
        c.amplitude[0] = v & 0x0F;
        c.amplitude[1] = (v >> 4) & 0x0F;
        return;
      }

      case 0x08: case 0x09: case 0x0A:
      case 0x0B: case 0x0C: case 0x0D:
        this.channels[reg - 0x08].frequency = v;
        return;

      case 0x10: case 0x11: case 0x12: {
        // Two channels per byte: bits 2-0 the even one, bits 6-4 the odd one.
        const base = (reg - 0x10) * 2;
        this.channels[base].octave = v & 0x07;
        this.channels[base + 1].octave = (v >> 4) & 0x07;
        return;
      }

      case 0x14:
        for (let i = 0; i < 6; i++) this.channels[i].toneEnabled = (v & (1 << i)) !== 0;
        return;

      case 0x15:
        for (let i = 0; i < 6; i++) this.channels[i].noiseEnabled = (v & (1 << i)) !== 0;
        return;

      case 0x16:
        this.setNoiseRate(0, v & 0x03);
        this.setNoiseRate(1, (v >> 4) & 0x03);
        return;

      case 0x18: case 0x19: {
        const e = this.envelopes[reg - 0x18];
        const wasEnabled = e.enabled;
        e.reverseRight = (v & 0x01) !== 0;
        e.shape = (v >> 1) & 0x07;
        e.threeBit = (v & 0x10) !== 0;
        e.externalClock = (v & 0x20) !== 0;
        e.enabled = (v & 0x80) !== 0;
        // A write restarts the envelope, and doubles as the external clock
        // when that mode is selected.
        if (!wasEnabled || !e.externalClock) {
          e.step = 0;
          e.finished = false;
        } else {
          this.stepEnvelope(reg - 0x18);
        }
        return;
      }

      case 0x1C:
        this.soundEnabled = (v & 0x01) !== 0;
        if (v & 0x02) {
          // Synchronise and reset every generator.
          for (const c of this.channels) { c.counter = 0; c.level = 0; }
          for (const n of this.noise) { n.counter = 0; n.lfsr = 0xFFFFFFFF; }
          for (const e of this.envelopes) { e.step = 0; e.finished = false; }
        }
        return;

      default:
        return;
    }
  }

  /** Noise rates 0-2 are fixed divisors; rate 3 slaves the generator to the
   *  tone counter of channel 0 (generator 0) or channel 3 (generator 1). */
  private setNoiseRate(gen: number, rate: number): void {
    const n = this.noise[gen];
    if (rate === 3) {
      n.period = -1;
      n.slavedTo = gen * 3;
    } else {
      n.period = 256 << rate;
      n.slavedTo = -1;
    }
  }

  // ── Generators ────────────────────────────────────────────────────────────

  /** Counter period in clock ticks for a channel's tone generator. */
  private divisor(c: Channel): number {
    return (511 - c.frequency) << (8 - c.octave);
  }

  private stepEnvelope(gen: number): void {
    const e = this.envelopes[gen];
    if (!e.enabled || e.finished) return;
    e.step++;
    if (e.step >= ENV_STEPS) {
      if (SINGLE_SHOT[e.shape]) {
        e.step = ENV_STEPS - 1;
        e.finished = true;
      } else {
        e.step = 0;
      }
    }
  }

  /** Envelope amplitude factor 0-15 for a generator, or 15 when it is off. */
  private envelopeFactor(gen: number, right: boolean): number {
    const e = this.envelopes[gen];
    if (!e.enabled) return 15;
    let step = e.step;
    // 3-bit resolution simply drops the least significant step bit.
    if (e.threeBit) step &= ~1;
    let level = ENVELOPE_SHAPES[e.shape][step];
    if (e.finished && SINGLE_SHOT[e.shape]) level = 0;
    if (right && e.reverseRight) level = 15 - level;
    return level;
  }

  /** Advance every generator by `ticks` chip clocks. */
  private clock(ticks: number): void {
    // Tone channels.
    for (let i = 0; i < 6; i++) {
      const c = this.channels[i];
      const div = this.divisor(c);
      c.counter -= ticks;
      while (c.counter <= 0) {
        c.counter += div;
        c.level ^= 1;
        // A tone generator also clocks the envelope of its group: channel 1
        // drives envelope 0, channel 4 drives envelope 1.
        if (i === 1 && !this.envelopes[0].externalClock) this.stepEnvelope(0);
        if (i === 4 && !this.envelopes[1].externalClock) this.stepEnvelope(1);
      }
    }

    // Noise generators.
    for (let g = 0; g < 2; g++) {
      const n = this.noise[g];
      const period = n.period > 0 ? n.period : this.divisor(this.channels[n.slavedTo]);
      n.counter -= ticks;
      while (n.counter <= 0) {
        n.counter += period;
        // x^18 + x^11 + x, plain XOR feedback.
        const feedback = ((n.lfsr & NOISE_TAP_A) === 0) !== ((n.lfsr & NOISE_TAP_B) === 0);
        n.lfsr = ((n.lfsr << 1) | (feedback ? 1 : 0)) >>> 0;
      }
    }
  }

  /** Current output of both stereo halves, before filtering, in -1..1. */
  private output(): { left: number; right: number } {
    if (!this.soundEnabled) return { left: 0, right: 0 };

    let left = 0;
    let right = 0;
    for (let i = 0; i < 6; i++) {
      const c = this.channels[i];
      const gen = i < 3 ? 0 : 1;

      // A channel with neither source enabled is silent; with both, the tone
      // gates the noise, which is how the chip mixes them.
      let on: boolean;
      if (c.toneEnabled && c.noiseEnabled) on = c.level !== 0 && (this.noise[gen].lfsr & 1) !== 0;
      else if (c.toneEnabled) on = c.level !== 0;
      else if (c.noiseEnabled) on = (this.noise[gen].lfsr & 1) !== 0;
      else continue;

      if (!on) continue;
      // Envelope generators modulate the last channel of their group.
      const envelope = (i === 2 || i === 5) ? gen : -1;
      const facL = envelope >= 0 ? this.envelopeFactor(envelope, false) : 15;
      const facR = envelope >= 0 ? this.envelopeFactor(envelope, true) : 15;
      left += (c.amplitude[0] * facL) / 15;
      right += (c.amplitude[1] * facR) / 15;
    }

    // Six channels at amplitude 15 each; normalise to keep the sum in range.
    const scale = 1 / (6 * 15);
    return { left: left * scale, right: right * scale };
  }

  /**
   * One stereo output sample. This is the `StereoAudioSource` contract the
   * shared `AudioMixer` consumes.
   */
  generateSampleStereo(): { left: number; right: number } {
    this.clock(this.ticksPerSample);
    const o = this.output();

    // DC-blocking high pass, so a steady level doesn't bias the mix.
    const outL = this.dcAlpha * (this.dcOutL + o.left - this.dcPrevL);
    const outR = this.dcAlpha * (this.dcOutR + o.right - this.dcPrevR);
    this.dcPrevL = o.left;
    this.dcPrevR = o.right;
    this.dcOutL = outL;
    this.dcOutR = outR;
    return { left: outL, right: outR };
  }

  // ── Introspection (tests, debug) ──────────────────────────────────────────

  /** Emitted square-wave frequency of a channel in Hz. */
  channelFrequency(ch: number): number {
    return this.chipClock / (2 * this.divisor(this.channels[ch]));
  }

  /** True while register 0x1C bit 0 is set. */
  get enabled(): boolean { return this.soundEnabled; }

  /** Amplitude nibbles [left, right] of a channel, for tests. */
  amplitudeOf(ch: number): readonly [number, number] {
    return this.channels[ch].amplitude;
  }

  /** Octave of a channel, for tests. */
  octaveOf(ch: number): number { return this.channels[ch].octave; }
}
