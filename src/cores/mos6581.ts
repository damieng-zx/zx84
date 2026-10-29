/**
 * MOS 6581 SID (Sound Interface Device).
 *
 * Three voices, each a 24-bit phase accumulator feeding sawtooth, triangle,
 * pulse and noise generators (selected waveforms are ANDed, as the chip's
 * open-drain outputs combine them), an ADSR envelope and the voice's DAC.
 * Voices can hard-sync to and ring-modulate with their neighbour. The voices
 * are routed through or around a multimode (low/band/high-pass) resonant
 * filter, and the master volume scales the mix. Voice 3's waveform and
 * envelope can be read back, which software uses for random numbers.
 * Shipped in the Commodore 64 and 128 and the CBM-II P500.
 *
 * Timing follows the data sheet: the accumulator adds the 16-bit frequency
 * every clock, noise is a 23-bit LFSR clocked by accumulator bit 19, and the
 * envelope steps once per rate period (attack linearly; decay and release
 * through the exponential divider that slows them at low levels). The rate
 * counter compares for equality and wraps at 15 bits, which gives the real
 * chip's "ADSR delay" when a period is shortened past the count.
 *
 * Like POKEY here, the chip is run lazily: `advanceTo(t)` clocks it to the
 * machine's cycle `t` and queues output samples, which the mixer takes with
 * `generateSampleStereo`. With audio off (`audible = false`) it still keeps
 * voice 3's oscillator and envelope moving for readback, cheaply.
 *
 * The filter follows envyplayer's 6581 model: a trapezoidal state-variable
 * filter run twice per output sample, its cutoff taken from a measured 6581
 * curve (sigmoid, with the DAC discontinuity at FC 1024) and pushed up by the
 * filter's own input (the 6581's VCR nonlinearity), resonance as 1/Q =
 * (15 - res) / 8, and the integrators soft-clipped as the op-amps saturate.
 * The voices carry a DC level that the volume register scales, so writing the
 * volume alone is audible — the 6581 effect sampled-sound players rely on.
 */

import type { StateSink, StateSource } from '@/utils/state-stream.ts';

/** Measured 6581 filter cutoff (FC register value → Hz), interpolated below. */
const F0_POINTS: readonly [number, number][] = [
  [0, 220], [128, 230], [256, 250], [384, 300], [512, 420], [640, 780], [768, 1600],
  [832, 2300], [896, 3200], [960, 4300], [992, 5000], [1008, 5400], [1016, 5700],
  [1023, 6000], [1024, 4600], [1032, 4800], [1056, 5300], [1088, 5800], [1120, 6600],
  [1152, 7600], [1280, 11000], [1408, 14000], [1536, 16000], [1664, 17000], [1792, 18000],
  [2047, 18000],
];

const F0_TABLE = new Float64Array(2048);
{
  let p = 0;
  for (let fc = 0; fc < 2048; fc++) {
    while (p < F0_POINTS.length - 2 && F0_POINTS[p + 1][0] <= fc) p++;
    const [x0, y0] = F0_POINTS[p];
    const [x1, y1] = F0_POINTS[p + 1];
    F0_TABLE[fc] = x1 === x0 ? y0 : y0 + (y1 - y0) * (fc - x0) / (x1 - x0);
  }
}

/** How far the filter input moves the cutoff, in FC steps per unit of input
 *  (one voice at full swing). */
const CUTOFF_MODULATION = 52.5;
/** Where the filter integrators saturate, in the same units. */
const FILTER_SAT = 1;

/** Envelope rate periods in clocks, indexed by the 4-bit ADSR value. Attack
 *  steps once per period; decay and release once per period times the
 *  exponential divisor. */
const RATE_PERIOD = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];

const ENV_ATTACK = 0;
const ENV_DECAY = 1;
const ENV_RELEASE = 2;

/** The exponential decay divisor at an envelope level. */
function expPeriodFor(level: number): number {
  if (level > 93) return 1;
  if (level > 54) return 2;
  if (level > 26) return 4;
  if (level > 14) return 8;
  if (level > 6) return 16;
  return 30;
}

const SAMPLE_BUFFER = 4096;
/** The voices' DC level, in waveform units, scaled by envelope and volume. */
const VOICE_DC = -0x380;
/** A fixed DC level at the mixer input, scaled only by the volume. */
const MIXER_DC = 0.18;
/** Mixer output per unit of voice swing: three loud voices stay inside ±1. */
const OUTPUT_GAIN = 0.32;
/** One voice at full envelope and full waveform swing. */
const VOICE_FULL = 2048 * 255;

class SidVoice {
  freq = 0;
  pw = 0;
  control = 0;
  attackDecay = 0;
  sustainRelease = 0;

  acc = 0;
  noise = 0x7FFFF8;
  /** Accumulator MSB rose on the last clock (the sync source for the next voice). */
  msbRose = false;

  envLevel = 0;
  envState = ENV_RELEASE;
  rateCounter = 0;
  ratePeriod = RATE_PERIOD[0];
  expCounter = 0;
  holdZero = true;

  reset(): void {
    this.freq = this.pw = this.control = this.attackDecay = this.sustainRelease = 0;
    this.acc = 0;
    this.noise = 0x7FFFF8;
    this.msbRose = false;
    this.envLevel = 0;
    this.envState = ENV_RELEASE;
    this.rateCounter = 0;
    this.ratePeriod = RATE_PERIOD[0];
    this.expCounter = 0;
    this.holdZero = true;
  }

  writeControl(v: number): void {
    const gateOn = (v & 1) !== 0 && (this.control & 1) === 0;
    const gateOff = (v & 1) === 0 && (this.control & 1) !== 0;
    if ((v & 0x08) !== 0) {
      // TEST holds the accumulator at zero and resets the noise register.
      this.acc = 0;
      this.noise = 0x7FFFF8;
    }
    this.control = v;
    if (gateOn) {
      this.envState = ENV_ATTACK;
      this.ratePeriod = RATE_PERIOD[this.attackDecay >> 4];
      this.holdZero = false;
    } else if (gateOff) {
      this.envState = ENV_RELEASE;
      this.ratePeriod = RATE_PERIOD[this.sustainRelease & 0x0F];
    }
  }

  /** Re-pick the rate period after an ADSR register write. */
  updateRate(): void {
    if (this.envState === ENV_ATTACK) this.ratePeriod = RATE_PERIOD[this.attackDecay >> 4];
    else if (this.envState === ENV_DECAY) this.ratePeriod = RATE_PERIOD[this.attackDecay & 0x0F];
    else this.ratePeriod = RATE_PERIOD[this.sustainRelease & 0x0F];
  }

  /** One envelope step, when the rate counter has hit its period. */
  private envStep(): void {
    if (this.envState === ENV_ATTACK) {
      this.expCounter = 0;
      this.envLevel = (this.envLevel + 1) & 0xFF;
      if (this.envLevel === 0xFF) {
        this.envState = ENV_DECAY;
        this.ratePeriod = RATE_PERIOD[this.attackDecay & 0x0F];
      }
      return;
    }
    if (++this.expCounter < expPeriodFor(this.envLevel)) return;
    this.expCounter = 0;
    if (this.holdZero) return;
    if (this.envState === ENV_DECAY) {
      if (this.envLevel !== (this.sustainRelease >> 4) * 0x11) this.envLevel--;
    } else {
      this.envLevel = (this.envLevel - 1) & 0xFF;
    }
    if (this.envLevel === 0) this.holdZero = true;
  }

  /** Run the envelope for `n` clocks. */
  clockEnvelope(n: number): void {
    while (n > 0) {
      let need = this.ratePeriod - this.rateCounter;
      // The counter compares for equality: past the period it runs on to the
      // 15-bit wrap first.
      if (need <= 0) need += 0x8000;
      if (need > n) { this.rateCounter = (this.rateCounter + n) & 0x7FFF; return; }
      n -= need;
      this.rateCounter = 0;
      this.envStep();
    }
  }

  /** Step the noise LFSR once (accumulator bit 19 rose). */
  clockNoise(): void {
    const s = this.noise;
    const bit = ((s >> 22) ^ (s >> 17)) & 1;
    this.noise = ((s << 1) | bit) & 0x7FFFFF;
  }

  /** The 12-bit waveform output, given the sync/ring source's accumulator. */
  wave(ringAcc: number): number {
    const sel = this.control >> 4;
    if (sel === 0) return 0x800;
    let out = 0xFFF;
    const acc = this.acc;
    if ((sel & 1) !== 0) {
      const msb = (this.control & 0x04) !== 0 ? (acc ^ ringAcc) & 0x800000 : acc & 0x800000;
      out &= ((msb !== 0 ? ~acc : acc) >> 11) & 0xFFF;
    }
    if ((sel & 2) !== 0) out &= acc >> 12;
    if ((sel & 4) !== 0) {
      if ((this.control & 0x08) === 0 && (acc >> 12) < (this.pw & 0xFFF)) out = 0;
    }
    if ((sel & 8) !== 0) {
      // The noise DAC taps register bits 20, 18, 14, 11, 9, 5, 2 and 0.
      const s = this.noise;
      out &= ((s >> 9) & 0x800) | ((s >> 8) & 0x400) | ((s >> 5) & 0x200) | ((s >> 3) & 0x100)
        | ((s >> 2) & 0x080) | ((s << 1) & 0x040) | ((s << 3) & 0x020) | ((s << 4) & 0x010);
    }
    return out;
  }

  saveState(w: StateSink): void {
    w.u16(this.freq); w.u16(this.pw); w.u8(this.control); w.u8(this.attackDecay); w.u8(this.sustainRelease);
    w.u32(this.acc); w.u32(this.noise);
    w.u8(this.envLevel); w.u8(this.envState); w.u16(this.rateCounter); w.u16(this.ratePeriod);
    w.u8(this.expCounter); w.bool(this.holdZero);
  }

  loadState(r: StateSource): void {
    this.freq = r.u16(); this.pw = r.u16(); this.control = r.u8(); this.attackDecay = r.u8(); this.sustainRelease = r.u8();
    this.acc = r.u32() & 0xFFFFFF; this.noise = r.u32() & 0x7FFFFF;
    this.envLevel = r.u8(); this.envState = r.u8(); this.rateCounter = r.u16() & 0x7FFF; this.ratePeriod = r.u16();
    this.expCounter = r.u8(); this.holdZero = r.bool();
    this.msbRose = false;
  }
}

export class Mos6581 {
  readonly voices = [new SidVoice(), new SidVoice(), new SidVoice()];
  /** Filter cutoff (11 bits), resonance (4 bits), routing and mode/volume. */
  cutoff = 0;
  resFilt = 0;
  modeVol = 0;
  /** The last value written to any register: reads of the write-only
   *  registers see it, the bus having held it. */
  private bus = 0;

  /** What the paddle lines read: POTX is axis 0, POTY axis 1. The machine
   *  supplies the paddles or mouse on the selected control port. */
  potRead: (axis: 0 | 1) => number = () => 0xFF;

  /** Clocks run so far. */
  now = 0;
  /** Queue output samples while clocking (false in turbo, which only keeps
   *  voice 3 moving for readback). */
  audible = true;

  private readonly clockHz: number;
  private sampleRate = 44100;
  private cyclesPerSample: number;
  /** Clocks left until the next output sample, and the voice sums for it. */
  private sampleLeft: number;
  private sumFilt = 0;
  private sumDirect = 0;
  private sumCount = 0;
  // State-variable filter integrators.
  private ic1 = 0;
  private ic2 = 0;
  private filterK = 1;
  private readonly samples = new Float32Array(SAMPLE_BUFFER);
  private sampleHead = 0;
  private sampleCount = 0;
  private lastSample = 0;
  private lastOut = { left: 0, right: 0 };

  constructor(clockHz: number) {
    this.clockHz = clockHz;
    this.cyclesPerSample = clockHz / this.sampleRate;
    this.sampleLeft = this.cyclesPerSample;
    this.updateFilter();
  }

  reset(): void {
    for (const v of this.voices) v.reset();
    this.cutoff = 0;
    this.resFilt = 0;
    this.modeVol = 0;
    this.bus = 0;
    this.ic1 = this.ic2 = 0;
    this.sumFilt = this.sumDirect = 0;
    this.sumCount = 0;
    this.sampleCount = 0;
    this.lastSample = 0;
    this.sampleLeft = this.cyclesPerSample;
    this.updateFilter();
  }

  setSampleRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.sampleRate = rate;
    this.cyclesPerSample = this.clockHz / rate;
    this.sampleLeft = this.cyclesPerSample;
    this.sumFilt = this.sumDirect = 0;
    this.sumCount = 0;
    this.updateFilter();
  }

  /** Resonance; the cutoff is worked out per sample, as it follows the input. */
  private updateFilter(): void {
    this.filterK = (15 - (this.resFilt >> 4)) / 8;
  }

  // ── Registers ────────────────────────────────────────────────────────────

  read(reg: number): number {
    switch (reg & 0x1F) {
      case 0x19: return this.potRead(0);   // POTX/POTY: nothing connected reads full scale
      case 0x1A: return this.potRead(1);
      case 0x1B: return this.voices[2].wave(this.voices[1].acc) >> 4;
      case 0x1C: return this.voices[2].envLevel;
      default: return this.bus;
    }
  }

  peek(reg: number): number { return this.read(reg); }

  write(reg: number, value: number): void {
    const v = value & 0xFF;
    this.bus = v;
    const r = reg & 0x1F;
    if (r < 21) {
      const voice = this.voices[Math.floor(r / 7)];
      switch (r % 7) {
        case 0: voice.freq = (voice.freq & 0xFF00) | v; break;
        case 1: voice.freq = (voice.freq & 0x00FF) | (v << 8); break;
        case 2: voice.pw = (voice.pw & 0x0F00) | v; break;
        case 3: voice.pw = (voice.pw & 0x00FF) | ((v & 0x0F) << 8); break;
        case 4: voice.writeControl(v); break;
        case 5: voice.attackDecay = v; voice.updateRate(); break;
        default: voice.sustainRelease = v; voice.updateRate(); break;
      }
      return;
    }
    switch (r) {
      case 0x15: this.cutoff = (this.cutoff & 0x7F8) | (v & 7); this.updateFilter(); break;
      case 0x16: this.cutoff = (this.cutoff & 7) | (v << 3); this.updateFilter(); break;
      case 0x17: this.resFilt = v; this.updateFilter(); break;
      case 0x18: this.modeVol = v; break;
      default: break;
    }
  }

  // ── Clocking ─────────────────────────────────────────────────────────────

  /** Run the chip to cycle `t`. */
  advanceTo(t: number): void {
    let n = Math.floor(t - this.now);
    if (n <= 0) return;
    this.now += n;
    if (!this.audible) { this.skip(n); return; }
    while (n > 0) {
      const chunk = Math.min(n, Math.max(1, Math.ceil(this.sampleLeft)));
      this.clockChunk(chunk);
      for (const v of this.voices) v.clockEnvelope(chunk);
      n -= chunk;
      this.sampleLeft -= chunk;
      if (this.sampleLeft <= 0) {
        this.sampleLeft += this.cyclesPerSample;
        this.emitSample();
      }
    }
  }

  /** Clock the oscillators `n` cycles, summing each voice's output. */
  private clockChunk(n: number): void {
    const [v0, v1, v2] = this.voices;
    const route = this.resFilt;
    const voice3Off = (this.modeVol & 0x80) !== 0 && (route & 4) === 0;
    const e0 = v0.envLevel, e1 = v1.envLevel, e2 = v2.envLevel;
    let filt = 0;
    let direct = 0;
    for (let c = 0; c < n; c++) {
      // Accumulators, noise clocks and MSB edges first, then sync, so every
      // voice sees its source's edge from this same clock.
      for (let i = 0; i < 3; i++) {
        const v = this.voices[i];
        if ((v.control & 0x08) !== 0) { v.msbRose = false; continue; }
        const prev = v.acc;
        const next = (prev + v.freq) & 0xFFFFFF;
        v.acc = next;
        v.msbRose = (prev & 0x800000) === 0 && (next & 0x800000) !== 0;
        if ((prev & 0x080000) === 0 && (next & 0x080000) !== 0) v.clockNoise();
      }
      if ((v0.control & 0x02) !== 0 && v2.msbRose) v0.acc = 0;
      if ((v1.control & 0x02) !== 0 && v0.msbRose) v1.acc = 0;
      if ((v2.control & 0x02) !== 0 && v1.msbRose) v2.acc = 0;

      const o0 = (v0.wave(v2.acc) - 0x800 + VOICE_DC) * e0;
      const o1 = (v1.wave(v0.acc) - 0x800 + VOICE_DC) * e1;
      const o2 = (v2.wave(v1.acc) - 0x800 + VOICE_DC) * e2;
      if ((route & 1) !== 0) filt += o0; else direct += o0;
      if ((route & 2) !== 0) filt += o1; else direct += o1;
      if ((route & 4) !== 0) filt += o2; else if (!voice3Off) direct += o2;
    }
    this.sumFilt += filt;
    this.sumDirect += direct;
    this.sumCount += n;
  }

  /** Filter and mix the clocks summed since the last sample and queue it. */
  private emitSample(): void {
    const count = this.sumCount || 1;
    const filtIn = this.sumFilt / count / VOICE_FULL;
    const direct = this.sumDirect / count / VOICE_FULL;
    this.sumFilt = this.sumDirect = 0;
    this.sumCount = 0;

    let fc = Math.round(this.cutoff + filtIn * CUTOFF_MODULATION);
    if (fc < 0) fc = 0; else if (fc > 2047) fc = 2047;
    const hz = Math.min(F0_TABLE[fc], this.sampleRate * 0.98);
    // Twice per sample (zero-order hold), so the top of the range stays stable.
    const g = Math.tan(Math.PI * hz / (2 * this.sampleRate));
    const k = this.filterK;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    let v1 = 0, v2 = 0;
    for (let os = 0; os < 2; os++) {
      const v3 = filtIn - this.ic2;
      v1 = a1 * this.ic1 + a2 * v3;
      v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
      this.ic1 = FILTER_SAT * Math.tanh((2 * v1 - this.ic1) / FILTER_SAT);
      this.ic2 = FILTER_SAT * Math.tanh((2 * v2 - this.ic2) / FILTER_SAT);
    }
    const mode = this.modeVol;
    let filtered = 0;
    if ((mode & 0x10) !== 0) filtered += v2;
    if ((mode & 0x20) !== 0) filtered += v1;
    if ((mode & 0x40) !== 0) filtered += filtIn - k * v1 - v2;

    const volume = (mode & 0x0F) / 15;
    const out = (filtered + direct + MIXER_DC) * volume * OUTPUT_GAIN;
    if (this.sampleCount === SAMPLE_BUFFER) {
      this.sampleHead = (this.sampleHead + 1) % SAMPLE_BUFFER;
      this.sampleCount--;
    }
    this.samples[(this.sampleHead + this.sampleCount) % SAMPLE_BUFFER] = out;
    this.sampleCount++;
  }

  /** Clock `n` cycles without output: oscillators by arithmetic, noise by
   *  its bit-19 edges, envelopes by their steps. Sync is not modelled here. */
  private skip(n: number): void {
    for (const v of this.voices) {
      if ((v.control & 0x08) === 0) {
        const total = v.acc + v.freq * n;
        const half = 0x80000;
        const rises = Math.floor((total + half) / 0x100000) - Math.floor((v.acc + half) / 0x100000);
        for (let i = 0; i < rises; i++) v.clockNoise();
        v.acc = total % 0x1000000;
      }
      v.clockEnvelope(n);
    }
    this.sampleCount = 0;
    this.sumFilt = this.sumDirect = 0;
    this.sumCount = 0;
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

  /** Drop queued samples (after a turbo run or a restore). */
  flush(): void {
    this.sampleCount = 0;
  }

  saveState(w: StateSink): void {
    for (const v of this.voices) v.saveState(w);
    w.u16(this.cutoff); w.u8(this.resFilt); w.u8(this.modeVol); w.u8(this.bus);
    w.f64(this.now);
  }

  loadState(r: StateSource): void {
    for (const v of this.voices) v.loadState(r);
    this.cutoff = r.u16() & 0x7FF; this.resFilt = r.u8(); this.modeVol = r.u8(); this.bus = r.u8();
    this.now = r.f64();
    this.ic1 = this.ic2 = 0;
    this.sumFilt = this.sumDirect = 0;
    this.sumCount = 0;
    this.sampleCount = 0;
    this.sampleLeft = this.cyclesPerSample;
    this.updateFilter();
  }
}
