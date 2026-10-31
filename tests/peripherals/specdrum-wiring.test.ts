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
    expect(s.specdrum.dac.code).toBe(0x80);   // untouched: still idle
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

  it('machine reset returns the latch to idle (0x80) and leaves it fitted', () => {
    s.cpu.portOut(0x00DF, 0xC8);
    s.reset();
    expect(s.specdrum.dac.code).toBe(0x80);
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
    s.applySettings(view({ specdrum: true, 'specdrum-volume': 200 }));
    expect(s.mixer.auxGain).toBe(2);          // the slider goes to 200 %: the DAC may exceed the speaker
    s.applySettings(view({ specdrum: true, 'specdrum-volume': 999 }));
    expect(s.mixer.auxGain).toBe(2);          // ...but no further
  });

  it('removing it live returns the latch to idle so a re-fit does not resume mid-level', () => {
    const s = makeMachine('zx48k');
    s.applySettings(view({ specdrum: true }));
    s.cpu.portOut(0x00DF, 0xF0);
    s.applySettings(view({ specdrum: false }));
    expect(s.specdrum.enabled).toBe(false);
    s.applySettings(view({ specdrum: true }));
    expect(s.specdrum.dac.code).toBe(0x80);
  });

  it('setSpecdrumFitted is idempotent and parks the latch at idle on a real removal', () => {
    const s = makeMachine('zx48k');
    s.setSpecdrumFitted(false);               // already off: nothing happens
    expect(s.specdrum.enabled).toBe(false);
    s.setSpecdrumFitted(true);
    s.setSpecdrumFitted(true);
    expect(s.specdrum.enabled).toBe(true);
    s.setSpecdrumFitted(false);
    expect(s.specdrum.enabled).toBe(false);
  });
});

describe('SpecDrum — audio path', () => {
  const ALPHA = 1 - (2 * Math.PI * 20 / 44100); // the mixer's ~20 Hz DC-blocker, 44.1 kHz default
  const frame = (s: Spectrum) => (s as unknown as { runFrame(): void }).runFrame();

  /** A 48K with `JR $` at 0x8000 and its audio captured into the returned array. */
  function rig(fitted: boolean, volume = 100): { s: Spectrum; out: number[] } {
    const s = makeMachine('zx48k');
    s.applySettings(view({ specdrum: fitted, 'specdrum-volume': volume }));
    s.memory.flat[0x8000] = 0x18; // JR $
    s.memory.flat[0x8001] = 0xFE;
    s.cpu.pc = 0x8000;
    const out: number[] = [];
    s.audio.pushSample = (l: number) => { out.push(l); };
    return { s, out };
  }

  /** One frame at the idle code, then step to `code` and return that second frame's samples. */
  function stepTo(fitted: boolean, code: number, volume = 100): number[] {
    const { s, out } = rig(fitted, volume);
    frame(s);
    const settled = out.length;
    s.specdrum.dac.write(code);
    frame(s);
    return out.slice(settled);
  }

  it('an idle DAC is silent: the signal is centred on 0x80, so nothing is added to the mix', () => {
    const { s, out } = rig(true);
    frame(s); frame(s);
    expect(out.length).toBeGreaterThan(1000);
    for (const x of out) expect(x).toBe(0);
  });

  it('a step to 0xC0 (+0.5) rings through the DC-blocker at 0.4·alpha, then decays by alpha per sample', () => {
    const base = stepTo(false, 0xC0);
    const withDac = stepTo(true, 0xC0);
    expect(withDac.length).toBe(base.length);
    expect(withDac.length).toBeGreaterThan(100);
    const d = withDac.map((x, i) => x - base[i]!);
    // The step lands inside a sample window, so it is spread over the first two samples;
    // from the third on it is the pure geometric tail.
    const peak = Math.max(...d);
    expect(peak).toBeCloseTo(0.5 * 0.8 * ALPHA, 1);
    for (let n = 3; n < 12; n++) expect(d[n + 1]! / d[n]!).toBeCloseTo(ALPHA, 6);
  });

  it('the SpecDrum slider scales the DAC alone', () => {
    const peak = (volume: number) => {
      // A quarter-scale step, so even 200 % stays inside the output clamp.
      const base = stepTo(false, 0xA0, volume);
      return Math.max(...stepTo(true, 0xA0, volume).map((x, i) => x - base[i]!));
    };
    expect(peak(50) / peak(100)).toBeCloseTo(0.5, 6);
    expect(peak(200) / peak(100)).toBeCloseTo(2, 6);
  });

  it('volume 0 silences the DAC but writes still reach it', () => {
    const base = stepTo(false, 0xC0, 0);
    const muted = stepTo(true, 0xC0, 0);
    for (let i = 0; i < base.length; i++) expect(muted[i]).toBeCloseTo(base[i]!, 12);
  });

  it('is signed: a code below idle swings the speaker the other way', () => {
    const base = stepTo(false, 0x40);
    const d = stepTo(true, 0x40).map((x, i) => x - base[i]!);
    expect(Math.min(...d)).toBeCloseTo(-0.5 * 0.8 * ALPHA, 1);
    expect(Math.max(...d)).toBeLessThanOrEqual(1e-9);
  });

  it('with the SpecDrum absent the output is untouched by the slider', () => {
    expect(stepTo(false, 0xC0, 10)).toEqual(stepTo(false, 0xC0, 100));
  });

  it('fitting it at idle does not thump', () => {
    const { s, out } = rig(false);
    frame(s);
    s.setSpecdrumFitted(true);                 // DAC rests at 0x80, which is 0: no edge
    frame(s); frame(s);
    for (const x of out) expect(x).toBe(0);
  });

  it('removing it at idle does not thump', () => {
    const { s, out } = rig(true);
    frame(s);
    s.setSpecdrumFitted(false);
    frame(s); frame(s);
    for (const x of out) expect(x).toBe(0);
  });

  it('removing it mid-sound steps by no more than the waveform\'s own value (a drum cut short)', () => {
    const { s, out } = rig(true);
    frame(s);
    s.specdrum.dac.write(0x90);                // +0.125 -> 0.1 at the speaker
    frame(s);
    const boundary = out.length;
    s.setSpecdrumFitted(false);
    frame(s);
    expect(Math.abs(out[boundary]! - out[boundary - 1]!)).toBeLessThanOrEqual(0.8 * 0.125 + 1e-9);
  });

  it('a machine reset at idle is silent', () => {
    const { s, out } = rig(true);
    frame(s);
    s.reset();
    s.cpu.pc = 0x8000;
    frame(s); frame(s);
    for (const x of out) expect(x).toBe(0);
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
    // A full 0x00..0xFF swing is +-0.8 (signed +-1 at the 0.8 aux scale); the duty is 0.497,
    // so the high half sits a hair above 0.8 once the small residual DC is removed.
    expect(max).toBeGreaterThan(0.6);
    expect(min).toBeLessThan(-0.6);
    expect(max).toBeLessThanOrEqual(0.85);
    expect(min).toBeGreaterThanOrEqual(-0.85);
  });
});

describe('SpecDrum — MIC sync tick', () => {
  // The Cheetah software pulses MIC (OUT 0xFE bit 3 only) as a sync clock. The MIC
  // leak into the speaker is off by default, so that clock does not tick.
  //   loop: LD A,08h / OUT (FEh),A / LD B,0 / DJNZ $ / XOR A / OUT (FEh),A / LD B,0 / DJNZ $ / JR loop
  const PROGRAM = [0x3E, 0x08, 0xD3, 0xFE, 0x06, 0x00, 0x10, 0xFE, 0xAF, 0xD3, 0xFE, 0x06, 0x00, 0x10, 0xFE, 0x18, 0xEF];

  function peak(micAudible: boolean): number {
    const s = makeMachine('zx48k');
    s.applySettings(view({}));
    s.ula.micAudible = micAudible;
    PROGRAM.forEach((b, i) => { s.memory.flat[0x8000 + i] = b; });
    s.cpu.pc = 0x8000;
    const out: number[] = [];
    s.audio.pushSample = (l: number) => { out.push(l); };
    for (let f = 0; f < 4; f++) (s as unknown as { runFrame(): void }).runFrame();
    return out.slice(500).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  }

  it('is silent on a machine with default settings', () => {
    const s = makeMachine('zx48k');
    s.applySettings(view({}));
    expect(s.ula.micAudible).toBe(false);
    expect(peak(false)).toBe(0);
  });

  it('would tick audibly if the MIC leak were enabled (the pulse itself is real)', () => {
    expect(peak(true)).toBeGreaterThan(0.02);
  });
});
