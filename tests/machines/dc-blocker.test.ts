import { describe, it, expect } from 'vitest';
import { DcBlocker } from '@/machines/shared/dc-blocker.ts';

describe('DcBlocker', () => {
  it('removes a constant offset', () => {
    const dc = new DcBlocker(48_000, false);
    let y = 0;
    for (let i = 0; i < 20_000; i++) y = dc.process(0.5);
    expect(Math.abs(y)).toBeLessThan(1e-3);
  });

  it('passes a step through at near full height, then decays it', () => {
    const dc = new DcBlocker(48_000, false);
    dc.process(0);
    const alpha = 1 - (2 * Math.PI * 20 / 48_000);
    expect(dc.process(1)).toBeCloseTo(alpha, 12);
    let y = 0;
    for (let i = 0; i < 48_000; i++) y = dc.process(1);
    expect(Math.abs(y)).toBeLessThan(0.01);
  });

  it('leaves a 440 Hz tone almost unchanged in level', () => {
    const rate = 48_000;
    const dc = new DcBlocker(rate);
    let peak = 0;
    for (let i = 0; i < rate; i++) {
      const y = dc.process(0.5 * Math.sin(2 * Math.PI * 440 * i / rate));
      if (i > rate / 2) peak = Math.max(peak, Math.abs(y));
    }
    expect(peak).toBeGreaterThan(0.49);
    expect(peak).toBeLessThanOrEqual(0.5 + 1e-3);
  });

  it('primes on the first sample when asked: a signal already at DC starts at zero', () => {
    const primed = new DcBlocker(48_000, true);
    expect(primed.process(0.7)).toBe(0);
    const unprimed = new DcBlocker(48_000, false);
    expect(unprimed.process(0.7)).toBeGreaterThan(0.69);
  });

  it('idle() re-seeds a primed filter and reset() clears it', () => {
    const dc = new DcBlocker(48_000, true);
    for (let i = 0; i < 100; i++) dc.process(0.2);
    dc.idle();
    expect(dc.process(0.9)).toBe(0);
    dc.reset();
    expect(dc.process(0.1)).toBe(0);
  });

  it('setSampleRate keeps the corner at 20 Hz', () => {
    const dc = new DcBlocker(44_100, false);
    dc.setSampleRate(96_000);
    dc.process(0);
    expect(dc.process(1)).toBeCloseTo(1 - (2 * Math.PI * 20 / 96_000), 12);
  });
});
