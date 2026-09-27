import { describe, expect, it } from 'vitest';
import { Sn76489, SN76489_VOLUME_TABLE, type Sn76489AntialiasMode } from '@/cores/sn76489.ts';

describe('SN76489', () => {
  it('combines the four-bit latch and six-bit data writes into a 10-bit tone period', () => {
    const psg = new Sn76489(4_000_000, 48_000);

    psg.write(0x85); // tone 0 low nibble = 5
    psg.write(0x2A); // tone 0 high six bits = 0x2A

    expect(psg.tonePeriod[0]).toBe(0x2A5);
    expect(psg.tonePeriod[1]).toBe(0);
  });

  it('data-only writes continue to update the most recently latched tone register', () => {
    const psg = new Sn76489(4_000_000, 48_000);

    psg.write(0xA3); // tone 1 low nibble
    psg.write(0x01);
    psg.write(0x3F);

    expect(psg.tonePeriod[1]).toBe(0x3F3);
  });

  it('applies data-only writes to an attenuation register after it is latched', () => {
    const psg = new Sn76489(4_000_000, 48_000);
    psg.write(0x8A);
    psg.write(0x01);
    expect(psg.tonePeriod[0]).toBe(0x01A);

    psg.write(0x95); // channel 0 attenuation
    psg.write(0x3F);

    expect(psg.attenuation[0]).toBe(15);
    expect(psg.tonePeriod[0]).toBe(0x01A);
  });

  it('provides distinct TI and 16-bit MTX noise-generator variants', () => {
    const ti = new Sn76489(4_000_000, 250_000, 'ti-15bit');
    const mtx = new Sn76489(4_000_000, 250_000, 'mtx');
    ti.setDcBlocking(false);
    mtx.setDcBlocking(false);
    for (const psg of [ti, mtx]) {
      psg.write(0xF0);
      psg.write(0xE4);
    }

    const tiSequence = Array.from({ length: 2048 }, () => ti.generateSample());
    const mtxSequence = Array.from({ length: 2048 }, () => mtx.generateSample());

    expect(tiSequence).not.toEqual(mtxSequence);
  });

  it('resets the noise LFSR whenever the noise-control register is written', () => {
    const psg = new Sn76489(4_000_000, 250_000);
    psg.setDcBlocking(false);
    psg.write(0xF0); // audible noise
    psg.write(0xE4); // white noise, fastest divider

    const first = Array.from({ length: 40 }, () => psg.generateSample());
    psg.write(0xE4);
    const second = Array.from({ length: 40 }, () => psg.generateSample());

    expect(second).toEqual(first);
  });

  it('uses 2 dB attenuation steps and mutes attenuation code 15', () => {
    expect(SN76489_VOLUME_TABLE[0]).toBe(1);
    expect(SN76489_VOLUME_TABLE[1]).toBeCloseTo(10 ** (-2 / 20), 6);
    expect(SN76489_VOLUME_TABLE[14]).toBeGreaterThan(0);
    expect(SN76489_VOLUME_TABLE[15]).toBe(0);
  });

  it('duplicates the mono hardware output into both stereo channels', () => {
    const psg = new Sn76489(4_000_000, 48_000);
    psg.write(0x90);
    const sample = psg.generateSampleStereo();
    expect(sample.left).toBe(sample.right);
  });
});

describe('SN76489 tone counter', () => {
  // clock/16 == sample rate, so each generateSample() is exactly one tick.
  const CLOCK = 1_600_000;
  const RATE = 100_000;

  function make(variant: 'ti-15bit' | 'sega' | 'mtx'): Sn76489 {
    const psg = new Sn76489(CLOCK, RATE, variant);
    psg.setDcBlocking(false);
    psg.write(0x90); // channel 0 full volume; others stay muted
    return psg;
  }

  /** Ticks until channel 0's output next changes (-1 if it never does). */
  function ticksToToggle(psg: Sn76489, cap = 5000): number {
    const start = psg.rawSample();
    for (let n = 1; n <= cap; n++) {
      if (psg.generateSample() !== start) return n;
    }
    return -1;
  }

  it('keeps counting when the period is rewritten mid-count', () => {
    const psg = make('ti-15bit');
    psg.write(0x8A); psg.write(0x00);         // period 10
    ticksToToggle(psg);                       // drain the reset count
    expect(ticksToToggle(psg)).toBe(10);      // steady state: 10 ticks
    // We sit on the toggle tick of a fresh 10-tick count. Advance 4.
    for (let i = 0; i < 4; i++) psg.generateSample();
    psg.write(0x8F); psg.write(0x03);         // period 0x3F (63)
    // The running count finishes (6 ticks left) before 63 takes effect.
    expect(ticksToToggle(psg)).toBe(6);
    expect(ticksToToggle(psg)).toBe(63);
  });

  it('treats a TI period of 0 as 0x400, not a constant level', () => {
    const psg = make('ti-15bit');
    psg.write(0x80); psg.write(0x00);         // period 0
    ticksToToggle(psg);
    expect(ticksToToggle(psg)).toBe(0x400);
  });

  it('holds the Sega PSG output constant for period 1', () => {
    const psg = make('sega');
    psg.write(0x81); psg.write(0x00);
    psg.generateSample();                     // output settles high
    expect(ticksToToggle(psg)).toBe(-1);
  });
});

describe('SN76489 — ultrasonic anti-aliasing', () => {
  // 'mtx' lets channels toggle right down to period 1 (unlike 'sega',
  // whose integrated PSG holds periods <=1 constant) — the case that
  // actually needs anti-aliasing, since the MTX drives the chip directly.
  const CLOCK = 4_000_000;
  const SAMPLE_RATE = 48_000;

  function collect(psg: Sn76489, n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(psg.generateSample());
    return out;
  }
  const range = (a: number[]) => Math.max(...a) - Math.min(...a);

  function setTone(psg: Sn76489, channel: number, period: number): void {
    const reg = channel * 2;
    psg.write(0x80 | (reg << 4) | (period & 0x0F));
    psg.write((period >> 4) & 0x3F);
  }

  // Channel 0 parked at tone `period`, full volume, channels 1/2 and noise
  // left silent (default attenuation 15 after reset).
  function oneChannel(mode: Sn76489AntialiasMode, period: number): Sn76489 {
    const psg = new Sn76489(CLOCK, SAMPLE_RATE, 'mtx');
    psg.setDcBlocking(false);
    psg.antialias = mode;
    setTone(psg, 0, period);
    psg.write(0x90); // channel 0 attenuation = 0 (full volume)
    // A new period only takes effect once the running count (0x400 ticks
    // from reset) expires — skip past it so we measure the programmed tone.
    collect(psg, Math.ceil(0x400 * 16 * SAMPLE_RATE / CLOCK) + 1);
    return psg;
  }

  it("'none' point-sampling aliases a period-1 tone (~62.5kHz) into a large varying ripple", () => {
    const s = collect(oneChannel('none', 1), 256);
    expect(range(s)).toBeGreaterThan(0.2);
  });

  it("'mute' turns an ultrasonic (period 1) channel into a constant level — no whine", () => {
    const s = collect(oneChannel('mute', 1), 256);
    expect(range(s)).toBe(0);
  });

  it("'mute' threshold is sample-rate dependent: at 4MHz/48kHz, periods up to 5 are also muted", () => {
    // period 5 -> 4e6/(32*5) = 25000 Hz, still above the 24kHz Nyquist at
    // 48kHz output (still ultrasonic on hardware, but would alias if
    // naively point-sampled) — a fixed "period <= 1" threshold would miss this.
    const s = collect(oneChannel('mute', 5), 256);
    expect(range(s)).toBe(0);
  });

  it("'box' filter cuts the aliasing ripple to a fraction of point-sampling", () => {
    const none = range(collect(oneChannel('none', 1), 256));
    const box = range(collect(oneChannel('box', 1), 256));
    expect(box).toBeLessThan(none / 2);
  });

  it("'mute' does NOT silence a normal audible channel", () => {
    // period 200 -> 4e6/(32*200) = 625 Hz, well within the audio band.
    const s = collect(oneChannel('mute', 200), 1024);
    expect(range(s)).toBeGreaterThan(0.2);
  });

  it('all four modes produce finite, bounded output', () => {
    for (const mode of ['none', 'box', 'mute', 'lowpass'] as const) {
      const s = collect(oneChannel(mode, 1), 128);
      for (const v of s) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThanOrEqual(1);
      }
    }
  });
});
