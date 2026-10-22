/**
 * SpecDrum wired into a real Spectrum: port routing, the write-only rule, reset,
 * settings plumbing, and the end-to-end audio path (OUT → DAC → mixer → samples).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import type { SettingsView } from '@/machines/machine.ts';
import type { SpectrumModel } from '@/models.ts';

function makeMachine(model: SpectrumModel): Spectrum {
  const s = new Spectrum(model, null);
  s.loadROM(new Uint8Array(64 * 1024));
  return s;
}

function view(values: Record<string, unknown>): SettingsView {
  return { get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; } };
}

describe('SpecDrum — port routing', () => {
  let s: Spectrum;
  beforeEach(() => {
    s = makeMachine('zx48k');
    s.specdrum.enabled = true;
  });

  it('OUT to low byte 0xDF reaches the DAC, whatever the high byte', () => {
    for (const [port, val] of [[0x00DF, 0x12], [0xFFDF, 0xFE], [0x7FDF, 0x80], [0xBFDF, 0x01]] as const) {
      s.cpu.portOut(port, val);
      expect(s.specdrum.dac.code, `port 0x${port.toString(16)}`).toBe(val);
    }
  });

  it('OUT to other ports does not reach the DAC', () => {
    s.specdrum.dac.write(0x42);
    for (const port of [0x00DE, 0x00DD, 0x00D7, 0x009F, 0x00FF, 0x001F, 0xDF00, 0x00E7]) {
      s.cpu.portOut(port, 0xAA);
    }
    expect(s.specdrum.dac.code).toBe(0x42);
  });

  it('is ignored while not fitted', () => {
    s.specdrum.enabled = false;
    s.cpu.portOut(0x00DF, 0xFF);
    expect(s.specdrum.dac.code).toBe(0);
    expect(s.activity.specdrumWrites).toBe(0);
  });

  it('counts writes in the per-frame activity and clears with the activity reset', () => {
    s.cpu.portOut(0x00DF, 1);
    s.cpu.portOut(0x00DF, 2);
    s.cpu.portOut(0x00DF, 3);
    expect(s.activity.specdrumWrites).toBe(3);
    s.activity.reset();
    expect(s.activity.specdrumWrites).toBe(0);
  });

  it('a DAC write is not also a ULA write, AY or paging access', () => {
    const t = makeMachine('zx128k');
    t.specdrum.enabled = true;
    const border = t.ula.borderColor;
    const bank = t.memory.port7FFD;
    t.cpu.portOut(0x7FDF, 0xFF); // bit 4 (EAR) and low border bits set in the value
    expect(t.ula.borderColor).toBe(border);
    expect(t.ula.beeperBit).toBe(0);
    expect(t.activity.beeperToggled).toBe(false);
    expect(t.memory.port7FFD).toBe(bank);
    expect(t.activity.ayWrites).toBe(0);
  });

  it('is write-only: IN 0xDF never returns the DAC level', () => {
    s.kempstonMouse.enabled = true;
    s.kempstonMouse.buttons = 0xFE;
    s.cpu.portIn(0xFADF);
    const before = s.cpu.portIn(0xFADF);
    s.cpu.portOut(0x00DF, 0x55);
    expect(s.cpu.portIn(0xFADF)).toBe(before);
    expect(before).toBe(0xFE);
  });

  it('coexists with the AMX mouse: its 0xDF button read is unchanged', () => {
    s.amxMouse.enabled = true;
    s.amxMouse.buttons = 0xBF;
    s.cpu.portOut(0x00DF, 0xFF);
    expect(s.cpu.portIn(0x00DF)).toBe(0xBF);
  });

  it('works on every model family (48K, 128K, +3)', () => {
    for (const model of ['zx48k', 'zx128k', 'zx128kplus3'] as SpectrumModel[]) {
      const m = makeMachine(model);
      m.specdrum.enabled = true;
      m.cpu.portOut(0x00DF, 0x99);
      expect(m.specdrum.dac.code, model).toBe(0x99);
    }
  });

  it('machine reset clears the latch but leaves it fitted', () => {
    s.cpu.portOut(0x00DF, 0xC8);
    s.reset();
    expect(s.specdrum.dac.code).toBe(0);
    expect(s.specdrum.enabled).toBe(true);
  });
});

describe('SpecDrum — settings', () => {
  it('prepare() fits it from the "specdrum" setting', () => {
    const s = makeMachine('zx48k');
    s.prepare(view({ specdrum: true }));
    expect(s.specdrum.enabled).toBe(true);
    s.prepare(view({}));
    expect(s.specdrum.enabled).toBe(false);
  });

  it('applySettings fits/removes it live and maps volume 0-100 onto the aux gain', () => {
    const s = makeMachine('zx48k');
    s.applySettings(view({ specdrum: true, 'specdrum-volume': 40 }));
    expect(s.specdrum.enabled).toBe(true);
    expect(s.mixer.auxGain).toBeCloseTo(0.4, 12);
    s.applySettings(view({ specdrum: true, 'specdrum-volume': 100 }));
    expect(s.mixer.auxGain).toBe(1);
  });

  it('removing it live clears the latch so a re-fit does not resume mid-level', () => {
    const s = makeMachine('zx48k');
    s.applySettings(view({ specdrum: true }));
    s.cpu.portOut(0x00DF, 0xF0);
    s.applySettings(view({ specdrum: false }));
    expect(s.specdrum.enabled).toBe(false);
    s.applySettings(view({ specdrum: true }));
    expect(s.specdrum.dac.code).toBe(0);
  });
});

describe('SpecDrum — audio path', () => {
  const ALPHA = 1 - (2 * Math.PI * 20 / 44100); // the mixer's ~20 Hz DC-blocker, 44.1 kHz default

  /** Run one frame of `JR $` in RAM and return the left samples produced. */
  function frameSamples(drum: { enabled: boolean; code?: number }, volume = 100): number[] {
    const s = makeMachine('zx48k');
    s.applySettings(view({ specdrum: drum.enabled, 'specdrum-volume': volume, 'ay-mix': 50 }));
    if (drum.code !== undefined) s.specdrum.dac.write(drum.code);
    s.memory.flat[0x8000] = 0x18; // JR $
    s.memory.flat[0x8001] = 0xFE;
    s.cpu.pc = 0x8000;
    const out: number[] = [];
    s.audio.pushSample = (l: number) => { out.push(l); };
    (s as unknown as { runFrame(): void }).runFrame();
    return out;
  }

  it('a held full-scale code contributes 0.8·α on the first sample, then decays by α each sample', () => {
    const base = frameSamples({ enabled: false });
    const withDac = frameSamples({ enabled: true, code: 255 });
    expect(withDac.length).toBe(base.length);
    expect(withDac.length).toBeGreaterThan(100);
    for (let n = 0; n < 4; n++) {
      // y[n] = 0.8 · α^(n+1) for a step to a constant level (first-order high-pass).
      expect(withDac[n]! - base[n]!).toBeCloseTo(0.8 * Math.pow(ALPHA, n + 1), 3);
    }
  });

  it('the SpecDrum slider scales the DAC alone', () => {
    const base = frameSamples({ enabled: false });
    const half = frameSamples({ enabled: true, code: 255 }, 50);
    expect(half[0]! - base[0]!).toBeCloseTo(0.5 * 0.8 * ALPHA, 3);
  });

  it('volume 0 silences the DAC but writes still reach it', () => {
    const base = frameSamples({ enabled: false });
    const muted = frameSamples({ enabled: true, code: 255 }, 0);
    expect(muted[0]).toBeCloseTo(base[0]!, 9);
  });

  it('a silent code (0x00) adds nothing', () => {
    const base = frameSamples({ enabled: false });
    const zero = frameSamples({ enabled: true, code: 0 });
    expect(zero[10]).toBeCloseTo(base[10]!, 9);
  });

  it('with the SpecDrum absent the output is untouched by the slider', () => {
    const a = frameSamples({ enabled: false }, 100);
    const b = frameSamples({ enabled: false }, 10);
    expect(b).toEqual(a);
  });
});

describe('SpecDrum — streamed samples (the way the real software drives it)', () => {
  // The Cheetah software plays with `OUT (0xDF),A`, which puts the sample on A8-A15 as
  // well. A square wave built the same way must come out of the mixer at the frequency
  // the Z80 loop sets, whatever the high byte is doing.
  //
  //   loop: LD A,FFh / OUT (DFh),A / LD B,50 / DJNZ $ / XOR A / OUT (DFh),A / LD B,50 / DJNZ $ / JR loop
  //   half 1 = 7+11+7+(49·13+8) = 670 T, half 2 = 4+11+7+645 = 667 T, JR = 12 T  → 1349 T per cycle
  const PROGRAM = [
    0x3E, 0xFF, 0xD3, 0xDF, 0x06, 0x32, 0x10, 0xFE,
    0xAF, 0xD3, 0xDF, 0x06, 0x32, 0x10, 0xFE, 0x18, 0xEF,
  ];
  const CYCLE_T = 1349;

  function run(frames: number, enabled: boolean): number[] {
    const s = makeMachine('zx48k');
    s.applySettings(view({ specdrum: enabled, 'specdrum-volume': 100 }));
    PROGRAM.forEach((b, i) => { s.memory.flat[0x8000 + i] = b; });
    s.cpu.pc = 0x8000;
    const out: number[] = [];
    s.audio.pushSample = (l: number) => { out.push(l); };
    for (let f = 0; f < frames; f++) (s as unknown as { runFrame(): void }).runFrame();
    return out;
  }

  /** Rising crossings through ±0.1 (hysteresis) — one per cycle of the square wave. */
  function risingEdges(samples: number[]): number {
    let low = false, edges = 0;
    for (const x of samples) {
      if (x < -0.1) low = true;
      else if (x > 0.1 && low) { low = false; edges++; }
    }
    return edges;
  }

  it('produces a tone at 3.5 MHz / 1349 T ≈ 2594 Hz', () => {
    const frames = 6;
    const edges = risingEdges(run(frames, true));
    const expected = (frames * 69888) / CYCLE_T; // ≈ 310.8 cycles
    expect(edges).toBeGreaterThan(expected * 0.97);
    expect(edges).toBeLessThan(expected * 1.03);
  });

  it('is silent with the SpecDrum not fitted (same program, port ignored)', () => {
    expect(risingEdges(run(6, false))).toBe(0);
  });

  it('swings both ways around zero after the DC-blocker, at a sensible level', () => {
    const out = run(6, true).slice(1000);
    const max = Math.max(...out), min = Math.min(...out);
    expect(max).toBeGreaterThan(0.2);
    expect(min).toBeLessThan(-0.2);
    expect(max).toBeLessThanOrEqual(0.8);
    expect(min).toBeGreaterThanOrEqual(-0.8);
  });
});
