/**
 * POKEY tests: keyboard code/IRQ behaviour, SKSTAT modifier lines, the timer
 * dividers, the RANDOM generator and volume-only audio.
 *
 * IRQST is active low on the real chip (0 = pending): the OS's dispatcher
 * at $E71F does `BIT IRQST / BEQ found`. A source only latches while its
 * IRQEN bit is set, and is acknowledged by clearing that bit.
 *
 * Expected timer timing follows the Altirra Hardware Reference Manual (5.2,
 * 5.3 and its Figure 8), in CPU cycles: the base clock is 64 kHz (CPU/28),
 * or 15 kHz (CPU/114) with AUDCTL bit 0; bit 6 clocks channel 1 and bit 5
 * channel 3 at 1.79 MHz; bit 4 joins 1+2 and bit 3 joins 3+4. A base-clock
 * channel fires every (AUDF+1)*base cycles, an 8-bit 1.79 MHz one every
 * AUDF+4, a 16-bit pair every (AUDFhi:AUDFlo)+7 at 1.79 MHz or (N+1)*base.
 * Fig. 8 gives exact cycles from an STIMER write at T: 8-bit AUDF1=0 fires
 * IRQST at T+8, T+12, T+16; a 1+2 pair with AUDF1=AUDF2=0 at T+8, T+15,
 * T+22 (timer 1) and T+11, T+18, T+25 (timer 2). The prescaler only resets
 * in initialisation mode: a period-0 timer on it first fires 24 (64 kHz) or
 * 83 (15 kHz) cycles after the SKCTL write that ends it.
 */

import { describe, it, expect } from 'vitest';
import { Pokey } from '@/machines/atari/pokey.ts';

function makePokey(): Pokey {
  return new Pokey(1_789_772);
}

describe('pokey interrupt status', () => {
  it('reads IRQST as all ones (nothing pending) except the idle transmitter', () => {
    const pokey = makePokey();
    // Bit 3 (serial output complete) is low while the transmitter is idle.
    expect(pokey.readReg(0x0e)).toBe(0xf7);
    expect(pokey.irq).toBe(false);
  });

  it('asserts IRQ for an enabled, idle transmitter (bit 3 is a level)', () => {
    const pokey = makePokey();
    pokey.writeReg(0x0e, 0x08);
    expect(pokey.irq).toBe(true);
    pokey.writeReg(0x0e, 0x00);
    expect(pokey.irq).toBe(false);
  });
});

describe('pokey keyboard', () => {
  it('loads KBCODE, pulls IRQST bit 6 low and reports the key as held', () => {
    const pokey = makePokey();
    pokey.writeReg(0x0f, 0x03); // enable keyboard scan
    pokey.writeReg(0x0e, 0x40); // enable the keyboard interrupt
    pokey.pressKey(0x3f, false, false);

    expect(pokey.kbcode).toBe(0x3f);
    expect(pokey.readReg(0x0e) & 0x40).toBe(0); // active low: pending
    expect(pokey.irq).toBe(true);
    expect(pokey.readSkstat() & 0x04).toBe(0); // bit 2 low while held
    expect(pokey.readSkstat() & 0x08).toBe(0x08); // shift not held
  });

  it('is acknowledged through IRQEN, not by reading KBCODE', () => {
    const pokey = makePokey();
    pokey.writeReg(0x0f, 0x03);
    pokey.writeReg(0x0e, 0x40);
    pokey.pressKey(0x3f, false, false);

    expect(pokey.readReg(0x09)).toBe(0x3f);
    expect(pokey.readReg(0x0e) & 0x40).toBe(0); // still pending

    // The OS's acknowledge: write the inverted mask, then POKMSK again.
    pokey.writeReg(0x0e, 0xbf);
    pokey.writeReg(0x0e, 0x40);
    expect(pokey.readReg(0x0e) & 0x40).toBe(0x40);
    expect(pokey.irq).toBe(false);
  });

  it('does not latch the keyboard interrupt while it is disabled', () => {
    const pokey = makePokey();
    pokey.writeReg(0x0f, 0x03);
    pokey.pressKey(0x3f, false, false);
    expect(pokey.kbcode).toBe(0x3f);
    pokey.writeReg(0x0e, 0x40); // enabling afterwards finds nothing pending
    expect(pokey.readReg(0x0e) & 0x40).toBe(0x40);
    expect(pokey.irq).toBe(false);
  });

  it('folds SHIFT and CONTROL into the code and drives SKSTAT bit 3', () => {
    const pokey = makePokey();
    pokey.writeReg(0x0f, 0x03);
    pokey.pressKey(0x1f, true, false);   // SHIFT+1
    expect(pokey.kbcode).toBe(0x5f);
    expect(pokey.readSkstat() & 0x08).toBe(0); // shift held

    pokey.pressKey(0x0e, false, true);   // CONTROL+-
    expect(pokey.kbcode).toBe(0x8e);
  });

  it('raises the separate BREAK interrupt', () => {
    const pokey = makePokey();
    pokey.writeReg(0x0f, 0x03);
    pokey.writeReg(0x0e, 0x80);
    expect(pokey.irq).toBe(false);
    pokey.breakKey();
    expect(pokey.readReg(0x0e) & 0x80).toBe(0); // pending
    expect(pokey.irq).toBe(true);
    // Disabling the source clears the pending flag.
    pokey.writeReg(0x0e, 0x00);
    expect(pokey.readReg(0x0e) & 0x80).toBe(0x80);
    expect(pokey.irq).toBe(false);
  });

  it('does not see BREAK, or a key, while the keyboard scan is off (SKCTL bit 1 clear)', () => {
    const pokey = makePokey();
    pokey.writeReg(0x0f, 0x01);       // scan off
    pokey.writeReg(0x0e, 0xc0);
    pokey.breakKey();
    pokey.pressKey(0x3f, true, false);
    expect(pokey.irq).toBe(false);
    expect(pokey.readReg(0x0e) & 0xc0).toBe(0xc0);
    expect(pokey.readSkstat() & 0x04).toBe(0x04);   // no key held
    expect(pokey.readSkstat() & 0x08).toBe(0x08);   // nor SHIFT
  });

  it('sets the keyboard overrun bit of SKSTAT when a key arrives before the last one is acknowledged', () => {
    const pokey = makePokey();
    pokey.writeReg(0x0f, 0x03);
    pokey.writeReg(0x0e, 0x40);
    pokey.pressKey(0x01, false, false);
    expect(pokey.readSkstat() & 0x40).toBe(0x40);   // one key: no overrun
    pokey.pressKey(0x02, false, false);             // IRQ still pending
    expect(pokey.kbcode).toBe(0x02);
    expect(pokey.readSkstat() & 0x40).toBe(0);
    pokey.writeReg(0x0a, 0);                        // SKRES clears it
    expect(pokey.readSkstat() & 0x40).toBe(0x40);
  });

  it('flags no overrun for a key after the interrupt has been acknowledged, or with it disabled', () => {
    const pokey = makePokey();
    pokey.writeReg(0x0f, 0x03);
    pokey.writeReg(0x0e, 0x40);
    pokey.pressKey(0x01, false, false);
    pokey.writeReg(0x0e, 0x00);                     // acknowledge
    pokey.writeReg(0x0e, 0x40);
    pokey.pressKey(0x02, false, false);
    expect(pokey.readSkstat() & 0x40).toBe(0x40);

    const off = makePokey();
    off.writeReg(0x0f, 0x03);
    off.pressKey(0x01, false, false);
    off.pressKey(0x02, false, false);
    expect(off.readSkstat() & 0x40).toBe(0x40);
  });
});

/** IRQEN/IRQST bit for each timer. */
const TIMER_BIT = { 1: 0x01, 2: 0x02, 4: 0x04 } as const;

/** A POKEY out of initialisation mode (at cycle 0), with AUDF and AUDCTL set. */
function running(audctl: number, audf: Record<number, number> = {}): Pokey {
  const pokey = makePokey();
  pokey.writeReg(0x0f, 0x03);
  for (const [ch, v] of Object.entries(audf)) pokey.writeReg((Number(ch) - 1) * 2, v);
  pokey.writeReg(0x08, audctl);
  return pokey;
}

/**
 * The cycles, counted from now, at which `timer`'s IRQST bit latches over
 * the next `cycles`, acknowledging each. `writes` are register writes to make
 * at given cycles (STIMER at 0 by default).
 */
function fireTimes(
  pokey: Pokey, timer: 1 | 2 | 4, cycles: number,
  writes: Record<number, [number, number][]> = { 0: [[0x09, 0x00]] },
): number[] {
  const bit = TIMER_BIT[timer];
  const times: number[] = [];
  pokey.writeReg(0x0e, bit);
  for (let t = 0; t < cycles; t++) {
    for (const [reg, v] of writes[t] ?? []) pokey.writeReg(reg, v);
    pokey.advance(1);
    if ((pokey.readReg(0x0e) & bit) === 0) {
      times.push(t);
      pokey.writeReg(0x0e, 0);
      pokey.writeReg(0x0e, bit);
    }
  }
  return times;
}

/** Differences between successive entries. */
const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]);

describe('pokey timers', () => {
  it('fires an 8-bit 1.79 MHz timer 8 cycles after STIMER, then every AUDF+4 (Fig. 8)', () => {
    expect(fireTimes(running(0x40, { 1: 0x00 }), 1, 17)).toEqual([8, 12, 16]);
    // AUDF1=5: reloads at T+3 and T+12, each fire a cycle after its reload.
    expect(fireTimes(running(0x40, { 1: 0x05 }), 1, 32)).toEqual([13, 22, 31]);
  });

  it('pre-empts the fire with an STIMER at T+4, but not at T+5', () => {
    expect(fireTimes(running(0x40, { 1: 0x00 }), 1, 13,
      { 0: [[0x09, 0]], 4: [[0x09, 0]] })).toEqual([12]);
    expect(fireTimes(running(0x40, { 1: 0x00 }), 1, 14,
      { 0: [[0x09, 0]], 5: [[0x09, 0]] })).toEqual([8, 13]);
  });

  it('fires a 1.79 MHz 1+2 pair at T+8/15/22 (timer 1) and T+11/18/25 (timer 2)', () => {
    expect(fireTimes(running(0x50, { 1: 0, 2: 0 }), 1, 23)).toEqual([8, 15, 22]);
    expect(fireTimes(running(0x50, { 1: 0, 2: 0 }), 2, 26)).toEqual([11, 18, 25]);
  });

  it('fires the low half of a pair AUDFhi+1 times a period: AUDFlo+7 after the pair, then every 256', () => {
    // N = $0140 at 1.79 MHz: the pair every $140+7 cycles; the low half
    // first after counting down from $40, then 256 later.
    const pair = fireTimes(running(0x50, { 1: 0x40, 2: 0x01 }), 2, 1400);
    expect(gaps(pair)).toEqual([0x147, 0x147, 0x147]);
    const low = fireTimes(running(0x50, { 1: 0x40, 2: 0x01 }), 1, 1400);
    expect(low[0]).toBe(0x40 + 8);
    expect(gaps(low).slice(0, 5)).toEqual([256, 0x40 + 7, 256, 0x40 + 7, 256]);
  });

  it('starts the prescaler when initialisation mode ends: first fire at 24 / 83 cycles', () => {
    const pokey64 = makePokey();
    pokey64.writeReg(0x0f, 0x03);
    expect(fireTimes(pokey64, 1, 81, {})).toEqual([24, 52, 80]);
    const pokey15 = makePokey();
    pokey15.writeReg(0x08, 0x01);
    pokey15.writeReg(0x0f, 0x03);
    expect(fireTimes(pokey15, 1, 200, {})).toEqual([83, 197]);
  });

  it('keeps prescaler timers on the prescaler grid after STIMER', () => {
    const pokey = running(0x00, { 1: 0x01 });
    const times = fireTimes(pokey, 1, 400, { 10: [[0x09, 0]] });
    // Two 64 kHz ticks a period; every fire still lands 24 + 28k cycles on.
    expect(times[0]).toBe(52);
    expect(times.every(t => (t - 24) % 28 === 0)).toBe(true);
    expect(gaps(times).every(g => g === 56)).toBe(true);
  });

  it('runs prescaler timers at (AUDF+1) * 28, or * 114 with AUDCTL bit 0', () => {
    expect(gaps(fireTimes(running(0x00, { 2: 0x09 }), 2, 1200))).toEqual([280, 280, 280]);
    expect(gaps(fireTimes(running(0x01, { 2: 0x03 }), 2, 2000))).toEqual([456, 456, 456]);
    expect(gaps(fireTimes(running(0x00, { 4: 0xff }), 4, 7168 * 3)).every(g => g === 7168)).toBe(true);
    // Bit 6 leaves channels 2 and 4 on the base clock.
    expect(gaps(fireTimes(running(0x40, { 4: 0x00 }), 4, 120))).toEqual([28, 28, 28]);
  });

  it('does not take the 1.79 MHz clock from AUDCTL bits 0-3', () => {
    // Bits 1-3 are the high-pass filters and the 3+4 join, not per-channel
    // clocks; with no join channel 2 stays at (AUDF2+1) * 28.
    expect(gaps(fireTimes(running(0x06, { 2: 0x01 }), 2, 300))).toEqual([56, 56, 56, 56]);
  });

  it('joins channels 1+2 with AUDCTL bit 4: (N+1) * base on the base clock', () => {
    // AUDF2:AUDF1 = $0003.
    expect(gaps(fireTimes(running(0x10, { 1: 0x03, 2: 0x00 }), 2, 500))).toEqual([112, 112, 112]);
    expect(gaps(fireTimes(running(0x11, { 1: 0x03, 2: 0x00 }), 2, 1600))).toEqual([456, 456]);
  });

  it('joins channels 3+4 with AUDCTL bit 3, not bit 5', () => {
    // AUDF4:AUDF3 = $0102 on the 64 kHz base.
    expect(gaps(fireTimes(running(0x08, { 3: 0x02, 4: 0x01 }), 4, 0x103 * 28 * 3 + 100)))
      .toEqual([0x103 * 28, 0x103 * 28]);
    // Bit 5 alone only speeds up channel 3; channel 4 keeps its 8-bit divider.
    expect(gaps(fireTimes(running(0x20, { 3: 0x02, 4: 0x01 }), 4, 230))).toEqual([56, 56, 56]);
  });

  it('runs a 3+4 pair at 1.79 MHz with bits 3 and 5: N+7 cycles', () => {
    // The SIO's 600 baud cassette setting, AUDF4:AUDF3 = $05CC.
    expect(gaps(fireTimes(running(0x28, { 3: 0xcc, 4: 0x05 }), 4, 0x5d3 * 3 + 50)))
      .toEqual([0x5d3, 0x5d3]);
  });

  it('stops prescaler timers, not 1.79 MHz ones, in initialisation mode', () => {
    const slow = makePokey();
    slow.writeReg(0x0f, 0x00);
    expect(fireTimes(slow, 1, 500)).toEqual([]);
    const fast = makePokey();
    fast.writeReg(0x08, 0x40);
    expect(fireTimes(fast, 1, 17)).toEqual([8, 12, 16]);
  });

  it('holds timers 3 and 4 in reset while asynchronous receive waits (SKCTL bit 4)', () => {
    const idle = running(0x00, { 4: 0x00 });
    idle.writeReg(0x0f, 0x13);
    expect(fireTimes(idle, 4, 500)).toEqual([]);
    idle.writeReg(0x0f, 0x03);
    expect(fireTimes(idle, 4, 500).length).toBeGreaterThan(10);
  });
});

/** The digital mix (total volume of the channels that are on, / 60) after
 *  each of the next `n` cycles: what the DACs are fed, before the analogue
 *  stages. */
function cycleLevels(pokey: Pokey, n: number): number[] {
  const levels: number[] = [];
  for (let i = 0; i < n; i++) {
    pokey.advance(1);
    levels.push(pokey.volumeSum / 60);
  }
  return levels;
}

/** Run `n` output samples at `rate` and return them. */
function samplesAt(pokey: Pokey, rate: number, n: number): number[] {
  pokey.setSampleRate(rate);
  const out: number[] = [];
  let done = 0;
  for (let i = 0; i < n; i++) {
    // Up to the cycle that completes sample i.
    const due = Math.ceil(((i + 1) * 1_789_772) / rate);
    pokey.advance(due - done);
    done = due;
    out.push(pokey.generateSampleStereo().left);
  }
  return out;
}

describe('pokey random and audio', () => {
  it('advances the 17-bit RANDOM generator as cycles pass', () => {
    const pokey = makePokey();
    pokey.writeReg(0x0f, 0x03); // leave initialisation mode
    const before = pokey.readReg(0x0a);
    pokey.advance(20);
    expect(pokey.readReg(0x0a)).not.toBe(before);
  });

  it('holds RANDOM at $FF in initialisation mode (SKCTL bits 0-1 clear)', () => {
    const pokey = makePokey();
    pokey.writeReg(0x0f, 0x00);
    pokey.advance(1000);
    expect(pokey.readReg(0x0a)).toBe(0xff);
  });

  // Altirra Hardware Reference Manual 5.5: in 9-bit mode, STA SKCTL leaving
  // initialisation mode then LDA RANDOM back to back (4 cycles) reads $1F;
  // sampling once a scan line (114 cycles) gives the run 00 DF EE 16 B9.
  it('reads $1F four cycles after leaving initialisation mode in 9-bit mode', () => {
    const pokey = makePokey();
    pokey.writeReg(0x08, 0x80);
    pokey.writeReg(0x0f, 0x00);
    pokey.writeReg(0x0f, 0x03);
    pokey.advance(4);
    expect(pokey.readReg(0x0a)).toBe(0x1f);
  });

  it('gives the run 00 DF EE 16 B9 when 9-bit RANDOM is read once a scan line', () => {
    const pokey = makePokey();
    pokey.writeReg(0x08, 0x80);
    pokey.writeReg(0x0f, 0x03);
    const reads: number[] = [];
    // 114 and 511 share no factor, so 511 reads visit every phase.
    for (let i = 0; i < 511 + 5; i++) { pokey.advance(114); reads.push(pokey.readReg(0x0a)); }
    const run = [0x00, 0xdf, 0xee, 0x16, 0xb9];
    expect(reads.some((_, i) => run.every((v, k) => reads[i + k] === v))).toBe(true);
  });

  it('mixes volume-only channels into the digital sum', () => {
    const pokey = makePokey();
    pokey.writeReg(0x01, 0x1f); // AUDC1: volume-only, volume 15
    pokey.writeReg(0x07, 0x13); // AUDC4: volume-only, volume 3
    expect(pokey.volumeSum).toBe(18);
    pokey.writeReg(0x01, 0x10); // volume-only, volume 0
    expect(pokey.volumeSum).toBe(3);
  });

  it('plays middle C for AUDF1=$79 on the 64 kHz clock', () => {
    // A pure tone toggles at each underflow: f = 1.79 MHz / (2 * 122 * 28),
    // 261.9 Hz, the Hardware Manual's middle-C setting.
    const pokey = running(0x00, { 1: 0x79 });
    pokey.setSampleRate(44100);
    pokey.writeReg(0x01, 0xa8); // pure tone, volume 8
    let rises = 0;
    let last = 0;
    let done = 0;
    for (let i = 0; i < 44100; i++) { // one second, sample by sample
      const due = Math.round(((i + 1) * 1_789_772) / 44100);
      pokey.advance(due - done);
      done = due;
      // AC-coupled, the square wave swings either side of zero.
      const high = pokey.generateSampleStereo().left > 0 ? 1 : 0;
      if (high && !last) rises++;
      last = high;
    }
    expect(rises).toBeGreaterThanOrEqual(260);
    expect(rises).toBeLessThanOrEqual(263);
  });

  it('reads RANDOM from the 9-bit poly with AUDCTL bit 7', () => {
    // A 9-bit maximal-length poly repeats every 511 cycles; the 17-bit one
    // every 131071.
    for (const [audctl, repeats] of [[0x80, true], [0x00, false]] as const) {
      const pokey = makePokey();
      pokey.writeReg(0x08, audctl);
      pokey.writeReg(0x0f, 0x03);
      const reads: number[] = [];
      for (let i = 0; i < 1022; i++) { pokey.advance(1); reads.push(pokey.readReg(0x0a)); }
      if (repeats) expect(reads.slice(0, 511)).toEqual(reads.slice(511));
      else expect(reads.slice(0, 511)).not.toEqual(reads.slice(511));
    }
  });

  it('silences a channel at volume zero', () => {
    const pokey = running(0x40, { 1: 0x00 });
    pokey.writeReg(0x01, 0xa0); // AUDC1: square wave, volume 0
    expect(samplesAt(pokey, 44100, 50).every(v => v === 0)).toBe(true);
  });
});

/**
 * The analogue output, per the Altirra Hardware Reference Manual's appendix
 * E: the volume bits drop the output by about 0.12, 0.26, 0.56 and 1.12 V,
 * normalised over 4 x 2.06 = 8.24 V; the sum saturates, 2.171x up to 0.14
 * and exponential above, 1 at full scale (section 5.3 adds that two channels
 * at volume 15 give only about 50% more amplitude than one). The first
 * amplifier stage AC-couples POKEY with a 2.6 ms time constant (0.992 a
 * sample at 48 kHz); external sources join after it; the second stage clips
 * its input to [-0.50, +0.65] and AC-couples again over 24.7 ms. The two
 * decays together give a mild overshoot below zero.
 *
 * Both coupling capacitors start empty, so a step from silence lands whole in
 * the first sample, and each later sample shows the stages' decay.
 */
describe('pokey analogue output', () => {
  /** POKEY's output before the amplifiers, `channels` volume-only at `volume`. */
  function dacLevel(volume: number, channels = [1]): number {
    const pokey = makePokey();
    for (const ch of channels) pokey.writeReg((ch - 1) * 2 + 1, 0x10 | volume);
    return pokey.outputLevel;
  }

  /** POKEY with channel 1 volume-only at `volume`, from silence. */
  function step(volume: number): Pokey {
    const pokey = makePokey();
    pokey.writeReg(0x01, 0x10 | volume);
    return pokey;
  }

  const RATE = 48000;
  /** Each stage's per-sample decay at 48 kHz. */
  const E1 = Math.exp(-1 / (0.0026 * RATE));
  const E2 = Math.exp(-1 / (0.0247 * RATE));

  it('steps the volume by the DAC bit voltages, not evenly', () => {
    const cv = [0, 12, 26, 38, 56, 68, 82, 94, 112]; // hundredths of a volt
    for (let v = 1; v <= 8; v++) {
      // Below the 0.14 knee the output is linear: 2.171 * drop / 8.24 V.
      expect(dacLevel(v)).toBeCloseTo((2.171 * cv[v]) / 824, 6);
    }
    // The gap from 3 to 4 is wider than from 2 to 3.
    expect(dacLevel(4) - dacLevel(3)).toBeGreaterThan(dacLevel(3) - dacLevel(2));
  });

  it('saturates the summed output: full scale at 1, two channels ~50% above one', () => {
    expect(dacLevel(15, [1, 2, 3, 4])).toBeCloseTo(1, 3);
    const ratio = dacLevel(15, [1, 2]) / dacLevel(15);
    expect(ratio).toBeGreaterThan(1.45);
    expect(ratio).toBeLessThan(1.6);
  });

  it('AC-couples POKEY through both stages: 2.6 ms, then 24.7 ms', () => {
    expect(E1).toBeCloseTo(0.992, 3); // the manual's 48 kHz figure
    const out = samplesAt(step(8), RATE, 2);
    expect(out[0]).toBeCloseTo((2.171 * 112) / 824, 6);
    // The first stage keeps E1 of its input, the second takes away 1 - E2.
    expect(out[1] / out[0]).toBeCloseTo(E1 + E2 - 1, 6);
  });

  it('overshoots slightly below zero after a step, then settles', () => {
    const out = samplesAt(step(8), RATE, RATE / 5); // 200 ms
    const low = Math.min(...out);
    expect(low).toBeLessThan(0);
    expect(low).toBeGreaterThan(-0.15 * out[0]);
    expect(Math.abs(out[out.length - 1])).toBeLessThan(0.01 * out[0]);
  });

  it('decays an external source with the second stage only: 24.7 ms', () => {
    const pokey = makePokey();
    pokey.setExternal(0.4);
    const out = samplesAt(pokey, RATE, 1187);
    expect(out[0]).toBeCloseTo(0.4, 6);
    expect(out[1] / out[0]).toBeCloseTo(E2, 6);
    // One time constant (1185.6 samples) on, 1/e is left.
    expect(out[1186] / out[0]).toBeCloseTo(Math.exp(-1186 / (0.0247 * RATE)), 3);
  });

  it('clips the second stage input to +0.65 on a loud step and -0.50 on the way back', () => {
    const pokey = makePokey();
    for (let ch = 1; ch <= 4; ch++) pokey.writeReg((ch - 1) * 2 + 1, 0x1f);
    // Full scale (1) arrives whole at the second stage: clipped to +0.65.
    expect(samplesAt(pokey, RATE, 1)[0]).toBeCloseTo(0.65, 6);
    // Held, both stages settle; dropping to silence swings the first stage's
    // output to -1, clipped to -0.50.
    samplesAt(pokey, RATE, RATE / 2);
    for (let ch = 1; ch <= 4; ch++) pokey.writeReg((ch - 1) * 2 + 1, 0x10);
    expect(samplesAt(pokey, RATE, 1)[0]).toBeCloseTo(-0.5, 3);
  });
});

/**
 * Distortion and filters, per the Altirra Hardware Reference Manual 5.3/5.5:
 * AUDC bit 7 clear passes the output through the 5-bit poly; bit 5 set gives
 * a pure tone, otherwise bit 6 picks the 4-bit poly over the 17-bit one
 * (9-bit with AUDCTL bit 7). The polys are XNOR shift registers, free-running
 * at 1.79 MHz from a zeroed start, maximal length, with one more 0 than 1:
 * 4-bit 000011101100101, 5-bit 0000011100100010101111011010011, 9-bit 255
 * ones in 511, 17-bit 65535 in 131071.
 *
 * Channel 3 runs at 1.79 MHz (AUDCTL bit 5), period AUDF3+4. A period of 16
 * is one more than a multiple of 15 and 32 one more than 31, so sampling at
 * the underflows reads the 4- and 5-bit patterns bit by bit; a period of 4
 * shares no factor with any poly length and so walks each whole sequence.
 * (Channel 3, because channels 1 and 2 play inverted while their filter is
 * off.)
 */
describe('pokey distortion and filters', () => {
  const P4 = '000011101100101';
  const P5 = '0000011100100010101111011010011';

  /** A POKEY rendering one CPU cycle per sample, channel 3 at 1.79 MHz. */
  function cycleAccurate(audctl: number, audc3: number, audf3 = 0x00): Pokey {
    const pokey = makePokey();
    pokey.setSampleRate(1_789_772);
    pokey.writeReg(0x0f, 0x03); // leave initialisation mode
    pokey.writeReg(0x08, audctl | 0x20);
    pokey.writeReg(0x04, audf3);
    pokey.writeReg(0x05, audc3);
    return pokey;
  }

  /** Channel 3's output at each of `n` consecutive fires `period` apart,
   *  from the first fire on (before it the flip-flop holds its start value). */
  function underflowBits(pokey: Pokey, n: number, period = 4): number[] {
    cycleLevels(pokey, period);
    const levels = cycleLevels(pokey, n * period);
    return levels.filter((_, i) => i % period === period - 1).map(l => (l > 0 ? 1 : 0));
  }

  /** The smallest period of `bits` (checked over its whole length). */
  function smallestPeriod(bits: number[]): number {
    for (let p = 1; p < bits.length; p++) {
      if (bits.every((b, i) => i + p >= bits.length || b === bits[i + p])) return p;
    }
    return bits.length;
  }

  /** True if `bits` is a rotation of `pattern`. */
  const isRotationOf = (bits: number[], pattern: string) => (pattern + pattern).includes(bits.join(''));
  const ones = (bits: number[]) => bits.reduce((a, b) => a + b, 0);
  const toggles = (bits: number[]) => bits.reduce((a, b, i) => a + (i > 0 && b !== bits[i - 1] ? 1 : 0), 0);

  it('plays the 4-bit poly for AUDC $C_: the pattern 000011101100101', () => {
    const bits = underflowBits(cycleAccurate(0x00, 0xc8, 12), 30, 16);
    expect(isRotationOf(bits.slice(0, 15), P4)).toBe(true);
    expect(smallestPeriod(bits)).toBe(15);
    expect(ones(bits.slice(0, 15))).toBe(7);
  });

  it('gates a pure tone with the 5-bit poly for AUDC $2_: it toggles on the pattern bits', () => {
    // A pure tone toggles every underflow; gated, only where the 5-bit bit is 1.
    expect(toggles(underflowBits(cycleAccurate(0x00, 0xa8), 31 * 20 + 1))).toBe(31 * 20);
    const bits = underflowBits(cycleAccurate(0x00, 0x28, 28), 31 * 2 + 1, 32);
    const toggled = bits.slice(1).map((b, i) => (b !== bits[i] ? 1 : 0));
    expect(isRotationOf(toggled.slice(0, 31), P5)).toBe(true);
    expect(ones(toggled.slice(0, 31))).toBe(15);
  });

  it('plays the 17-bit poly for AUDC $8_, or the 9-bit one with AUDCTL bit 7', () => {
    const nine = underflowBits(cycleAccurate(0x80, 0x88), 1022);
    expect(smallestPeriod(nine)).toBe(511);
    expect(ones(nine.slice(0, 511))).toBe(255);

    const seventeen = underflowBits(cycleAccurate(0x00, 0x88), 131071 + 600);
    expect(seventeen.slice(0, 600)).toEqual(seventeen.slice(131071));
    expect(smallestPeriod(seventeen.slice(0, 1022))).not.toBe(511);
    expect(ones(seventeen.slice(0, 131071))).toBe(65535);
  });

  it('combines the 5- and 4-bit polys for AUDC $4_: period 15 * 31', () => {
    // The 5-bit poly starts 00000, so skip the first 31 underflows, before the
    // gate has opened and the output still holds its start value.
    const bits = underflowBits(cycleAccurate(0x00, 0x48), 31 + 465 * 2).slice(31);
    expect(smallestPeriod(bits)).toBe(465);
  });

  /** Channels `a` and `b` (1-4) on the same pure tone, started by STIMER. */
  function pair(a: number, b: number): Pokey {
    const pokey = running(0x00);
    for (const ch of [a, b]) {
      pokey.writeReg((ch - 1) * 2, 0x0f);     // 64 kHz / 16: period 448
      pokey.writeReg((ch - 1) * 2 + 1, 0xa8); // pure tone, volume 8
    }
    pokey.writeReg(0x09, 0x00); // STIMER
    return pokey;
  }

  /** The distinct mixed levels (in volume units) seen over `cycles`. */
  function levels(pokey: Pokey, cycles: number): number[] {
    const seen = new Set(cycleLevels(pokey, cycles).map(l => Math.round(l * 60)));
    return [...seen].sort((x, y) => x - y);
  }

  it('sets every output flip-flop to 1 on STIMER: channels 1-2 off, 3-4 on', () => {
    // With the filters off channels 1 and 2 play their output inverted.
    const pokey = makePokey();
    pokey.setSampleRate(1_789_772);
    pokey.writeReg(0x00, 0xff);
    pokey.writeReg(0x01, 0xa8);
    pokey.writeReg(0x09, 0x00);
    expect(pokey.volumeSum).toBe(0);
    pokey.writeReg(0x01, 0xa0);
    pokey.writeReg(0x04, 0xff);
    pokey.writeReg(0x05, 0xa8);
    pokey.writeReg(0x09, 0x00);
    expect(pokey.volumeSum).toBe(8);
  });

  it('still plays the low half of a linked pair', () => {
    // 1+2 joined at 1.79 MHz; channel 1 (the low half) at volume 8 toggles
    // on its own fires, channel 2 is silent.
    const pokey = running(0x50, { 1: 0x10, 2: 0x00 });
    pokey.writeReg(0x01, 0xa8);
    expect(new Set(cycleLevels(pokey, 400).map(l => Math.round(l * 60)))).toEqual(new Set([0, 8]));
  });

  it('silences channels 3 and 4 while asynchronous receive waits', () => {
    const pokey = running(0x00, { 4: 0x00 });
    pokey.writeReg(0x07, 0xa8); // channel 4 pure tone, volume 8
    pokey.writeReg(0x0f, 0x13);
    const held = cycleLevels(pokey, 600);
    expect(new Set(held).size).toBe(1);
  });

  it('adds channels 1 and 2 in step but cancels 1 against 3 (filter-off inversion)', () => {
    expect(levels(pair(1, 2), 448 * 10)).toEqual([0, 16]);
    expect(levels(pair(1, 3), 448 * 10)).toEqual([8]);
  });

  /** Fraction of cycles channel 1 is high over `cycles`. */
  function dutyOf(pokey: Pokey, cycles: number): number {
    return cycleLevels(pokey, cycles).filter(l => l > 0).length / cycles;
  }

  it('high-pass filters channel 1 by channel 3 with AUDCTL bit 2', () => {
    // Channel 1: a pure tone at 64 kHz / 256 (period 7168). Channel 3, at
    // volume 0, clocks the filter.
    const setup = (audctl: number, audf3: number) => {
      const pokey = running(audctl);
      pokey.writeReg(0x00, 0xff);
      pokey.writeReg(0x01, 0xa8);
      pokey.writeReg(0x04, audf3);
      return pokey;
    };
    // Unfiltered: a square wave, high half the time.
    expect(dutyOf(setup(0x00, 0x00), 7168 * 20)).toBeCloseTo(0.5, 1);
    // Filter channel far faster than the tone (1.79 MHz, every 4 cycles): the
    // tone is below the cut-off and only the 4-cycle edge glitches remain.
    expect(dutyOf(setup(0x24, 0x00), 7168 * 20)).toBeLessThan(0.002);
  });

  it('passes a tone above the filter rate', () => {
    // Channel 2 at 64 kHz / 16 (period 448); channel 4, the filter clock,
    // at 64 kHz / 256: the tone mostly gets through.
    const pokey = running(0x02);
    pokey.writeReg(0x02, 0x0f);
    pokey.writeReg(0x03, 0xa8);
    pokey.writeReg(0x06, 0xff);
    const duty = dutyOf(pokey, 7168 * 20);
    expect(duty).toBeGreaterThan(0.4);
    expect(duty).toBeLessThan(0.6);
  });
});

/**
 * Serial output. SEROUT is a holding register in front of a shift register
 * clocked by channel 4: a byte is ten bits of two channel-4 periods. IRQST
 * bit 4 (output data needed) latches when the holding register empties; bit
 * 3 (transmission complete) reads low while nothing is being sent. Both are
 * active low on read.
 */
describe('pokey serial output', () => {
  function sender(): { pokey: Pokey; sent: number[]; byteCycles: number; period: number } {
    const pokey = makePokey();
    const sent: number[] = [];
    pokey.onSerialOut = (b) => sent.push(b);
    pokey.writeReg(0x06, 0x09);       // AUDF4 = 9
    pokey.writeReg(0x08, 0x00);       // AUDCTL: 64 kHz base, 28 cycles a tick
    pokey.writeReg(0x0e, 0x18);       // enable data-needed and complete
    // Channel 4 period (9 + 1) x 28 = 280 cycles; a bit is two periods.
    return { pokey, sent, byteCycles: 10 * 2 * 280, period: 280 };
  }

  it('loads an idle shifter on its next clock, not at the write', () => {
    // Altirra HRM ch. 5: the shift register only loads on a serial clock
    // edge, and "serial output ready" asserts when it does.
    const { pokey, sent, period } = sender();
    expect(pokey.readReg(0x0e) & 0x08).toBe(0); // idle: complete
    pokey.writeReg(0x0d, 0x55);
    expect(sent).toEqual([]);
    expect(pokey.readReg(0x0e) & 0x10).toBe(0x10); // not yet: no data needed
    expect(pokey.readReg(0x0e) & 0x08).toBe(0);    // shifter still idle
    pokey.advance(period);
    expect(sent).toEqual([0x55]);
    expect(pokey.readReg(0x0e) & 0x10).toBe(0);    // data needed (pending)
    expect(pokey.readReg(0x0e) & 0x08).toBe(0x08); // sending: not complete
  });

  it('sends only the second of two writes made before the shifter loads', () => {
    const { pokey, sent, period } = sender();
    pokey.writeReg(0x0d, 0x11);
    pokey.writeReg(0x0d, 0x22);
    pokey.advance(period);
    expect(sent).toEqual([0x22]);
  });

  it('holds a second byte until the first has shifted out', () => {
    const { pokey, sent, byteCycles, period } = sender();
    pokey.writeReg(0x0d, 0x11);
    pokey.advance(period);
    expect(sent).toEqual([0x11]);
    pokey.writeReg(0x0e, 0x08);   // acknowledge data-needed
    pokey.writeReg(0x0e, 0x18);
    pokey.writeReg(0x0d, 0x22);   // waits in SEROUT
    expect(pokey.readReg(0x0e) & 0x10).toBe(0x10);
    pokey.advance(byteCycles - period - 1);
    expect(sent).toEqual([0x11]);
    pokey.advance(period + 1);
    expect(sent).toEqual([0x11, 0x22]);
    expect(pokey.readReg(0x0e) & 0x10).toBe(0);
    pokey.advance(byteCycles);
    expect(pokey.readReg(0x0e) & 0x08).toBe(0); // both sent: complete
  });
});

describe('pokey pot scan', () => {
  const POTGO = 0x0b;
  const ALLPOT = 0x08;

  /** A POKEY with its serial and pot clocks running, as the OS leaves it. */
  function running(skctl = 0x03): Pokey {
    const pokey = makePokey();
    pokey.writeReg(0x0f, skctl);
    return pokey;
  }

  it('reads zero from every pot and from ALLPOT before a scan has run', () => {
    const pokey = makePokey();
    expect(pokey.readReg(ALLPOT)).toBe(0x00);
    for (let i = 0; i < 8; i++) expect(pokey.readReg(i)).toBe(0x00);
  });

  it('counts a slow scan up once per 15 kHz tick, with ALLPOT set until it ends', () => {
    const pokey = running();
    pokey.writeReg(POTGO, 0);
    expect(pokey.readReg(ALLPOT)).toBe(0xff);
    pokey.advance(114 * 10 + 5);
    expect(pokey.readReg(0)).toBe(10);
    expect(pokey.readReg(7)).toBe(10);
    expect(pokey.readReg(ALLPOT)).toBe(0xff);
    pokey.advance(114 * 100);
    expect(pokey.readReg(3)).toBe(110);
    expect(pokey.readReg(ALLPOT)).toBe(0xff);
  });

  it('ends a slow scan at 228, with ALLPOT clear and unconnected pots latched there', () => {
    const pokey = running();
    pokey.writeReg(POTGO, 0);
    pokey.advance(114 * 228 - 1);
    expect(pokey.readReg(ALLPOT)).toBe(0xff);
    expect(pokey.readReg(0)).toBe(227);
    pokey.advance(2);
    expect(pokey.readReg(ALLPOT)).toBe(0x00);
    for (let i = 0; i < 8; i++) expect(pokey.readReg(i)).toBe(228);
    // It stays put however long it is left.
    pokey.advance(100000);
    expect(pokey.readReg(0)).toBe(228);
    expect(pokey.readReg(ALLPOT)).toBe(0x00);
  });

  it('counts a fast scan every cycle and ends it at 229', () => {
    const pokey = running(0x07);
    pokey.writeReg(POTGO, 0);
    pokey.advance(100);
    expect(pokey.readReg(0)).toBe(100);
    expect(pokey.readReg(ALLPOT)).toBe(0xff);
    pokey.advance(129);
    expect(pokey.readReg(ALLPOT)).toBe(0x00);
    expect(pokey.readReg(0)).toBe(229);
  });

  it('restarts from zero when POTGO is written during a scan', () => {
    const pokey = running();
    pokey.writeReg(POTGO, 0);
    pokey.advance(114 * 50);
    expect(pokey.readReg(0)).toBe(50);
    pokey.writeReg(POTGO, 0);
    expect(pokey.readReg(0)).toBe(0);
    pokey.advance(114 * 3);
    expect(pokey.readReg(0)).toBe(3);
  });

  it('never finishes a slow scan with the 15 kHz clock stopped (initialisation mode)', () => {
    const pokey = running(0x00);
    pokey.writeReg(POTGO, 0);
    pokey.advance(114 * 400);
    expect(pokey.readReg(ALLPOT)).toBe(0xff);
    expect(pokey.readReg(0)).toBe(0);
  });
});

describe('pokey output flip-flops', () => {
  it('power up at 1: channels 1 and 2 (through their idle high-pass) start off, 3 and 4 on', () => {
    const pokey = makePokey();
    for (let c = 0; c < 4; c++) pokey.writeReg(c * 2 + 1, 0xa0 | 0x08); // pure tone, volume 8
    pokey.writeReg(0x0f, 0x03);
    // Channels 1 and 2 are out ^ hp = 1 ^ 1 = 0 and channels 3 and 4 are 1.
    expect(pokey.volumeSum).toBe(16);
  });

  it('has the high-pass filter sample a channel before the same cycle changes it', () => {
    // Channel 1 filtered by channel 3 (AUDCTL bit 2), both counting down from
    // the same STIMER with the same period, so they fire on the same cycle.
    // Channel 3 samples channel 1's output as it was before that fire, so the
    // filtered output is the new level against the old one: always on. Were
    // channel 1 handled first it would be against itself: always off.
    const pokey = running(0x04, { 1: 4, 3: 4 });
    pokey.writeReg(0x01, 0xaf);    // channel 1: pure tone, volume 15
    pokey.writeReg(0x05, 0xa0);    // channel 3: silent, it only clocks the filter
    pokey.writeReg(0x09, 0);       // STIMER
    pokey.advance(5 * 28 * 3);     // past the first few fires
    let on = 0;
    for (let i = 0; i < 40; i++) {
      pokey.advance(37);
      if (pokey.volumeSum === 15) on++;
    }
    expect(on).toBe(40);
  });
});
