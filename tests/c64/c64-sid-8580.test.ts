/**
 * The 8580 option of the SID: the C64C's chip is centred (no DC level for the
 * volume register to scale), its filter cutoff is a near-straight line to
 * 12.5 kHz where the 6581's is an S-curve, and the machine takes the choice
 * from the `c64-sid` setting.
 */

import { describe, it, expect } from 'vitest';
import { Mos6581, type SidModel } from '@/cores/mos6581.ts';
import { C64Machine } from '@/machines/c64/c64-machine.ts';

const CLOCK = 985_248;
const FRAME = 19_656;

/** Run a SID for `frames` frames, returning every sample it produced. */
function render(sid: Mos6581, frames: number): number[] {
  const out: number[] = [];
  let t = sid.now;
  for (let f = 0; f < frames; f++) {
    t += FRAME;
    sid.advanceTo(t);
    for (let i = 0; i < 900; i++) out.push(sid.generateSampleStereo().left);
  }
  return out;
}

const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
const rms = (a: number[]): number => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
};

/** A 2 kHz sawtooth through the low-pass filter at cutoff `fc`, volume 15. */
function sawThroughLowPass(model: SidModel, fc: number): number[] {
  const sid = new Mos6581(CLOCK);
  sid.setModel(model);
  sid.reset();
  sid.write(0, 34058 & 0xFF); sid.write(1, 34058 >> 8);          // about 2 kHz
  sid.write(5, 0x00); sid.write(6, 0xF0);                        // instant attack, full sustain
  sid.write(21, fc & 7); sid.write(22, fc >> 3);
  sid.write(23, 0x01);                                           // voice 1 through the filter, no resonance
  sid.write(24, 0x1F);                                           // low-pass, volume 15
  sid.write(4, 0x21);                                            // sawtooth, gate on
  const samples = render(sid, 12);
  return samples.slice(samples.length / 2);                      // after it has settled
}

describe('the SID model', () => {
  it('is a 6581 until it is told otherwise, and can be switched back', () => {
    const sid = new Mos6581(CLOCK);
    expect(sid.model).toBe('6581');
    sid.setModel('8580');
    expect(sid.model).toBe('8580');
    sid.setModel('6581');
    expect(sid.model).toBe('6581');
  });

  it('keeps the registers across a switch', () => {
    const sid = new Mos6581(CLOCK);
    sid.write(0, 0x34); sid.write(1, 0x12);
    sid.write(21, 5); sid.write(22, 0x40);
    sid.setModel('8580');
    expect(sid.voices[0].freq).toBe(0x1234);
    expect(sid.cutoff).toBe((0x40 << 3) | 5);
  });

  it('puts a DC level under the 6581\'s volume register and none under the 8580\'s', () => {
    const level = (model: SidModel): number => {
      const sid = new Mos6581(CLOCK);
      sid.setModel(model);
      sid.reset();
      sid.write(24, 0x0F);                       // volume only: no voice playing
      const samples = render(sid, 4);
      return Math.abs(mean(samples.slice(samples.length / 2)));
    };
    expect(level('6581')).toBeGreaterThan(0.02);
    expect(level('8580')).toBeLessThan(0.001);
  });

  it('cuts a 2 kHz saw far harder at a low cutoff on the 6581 than the 8580, where the cutoff is higher', () => {
    // FC 512: about 420 Hz on the 6581, about 3.3 kHz on the 8580.
    const a = rms(sawThroughLowPass('6581', 512));
    const b = rms(sawThroughLowPass('8580', 512));
    expect(b).toBeGreaterThan(a * 2.5);
  });

  it('passes the same saw alike at the very top of the range, where both curves open out', () => {
    const a = rms(sawThroughLowPass('6581', 2047));
    const b = rms(sawThroughLowPass('8580', 2047));
    expect(b / a).toBeGreaterThan(0.5);
    expect(b / a).toBeLessThan(2);
  });
});

describe('the machine\'s SID setting', () => {
  const view = (value: string) => ({ get: <T>(key: string, fallback: T): T => (key === 'c64-sid' ? (value as unknown as T) : fallback) });

  it('follows c64-sid', () => {
    const m = new C64Machine('c64', null);
    expect(m.sid.model).toBe('6581');
    m.applySettings(view('8580'));
    expect(m.sid.model).toBe('8580');
    m.applySettings(view('6581'));
    expect(m.sid.model).toBe('6581');
    m.applySettings(view('anything else'));
    expect(m.sid.model).toBe('6581');
    m.destroy();
  });

  it('names the chip in the debugger\'s dump', () => {
    const m = new C64Machine('c64', null);
    const dump = () => m.services.debug.chips!().find(c => c.name === 'sid')!.dump();
    expect(dump()).toContain('MOS 6581');
    m.applySettings(view('8580'));
    expect(dump()).toContain('MOS 8580');
    m.destroy();
  });
});
