/**
 * WAVE recording → pulse stream, and every pulse-deck machine's use of it.
 *
 * Expected pulse lengths are worked out from the 3.5MHz tape reference
 * (T-states = samples × 3 500 000 / sampleRate) rather than read back from the
 * converter, and the recordings are synthesised square waves whose edge
 * positions are known by construction.
 */

import { describe, it, expect } from 'vitest';
import { wavToPulseBlocks } from '@/media/tape/wav.ts';
import { parseAcornTape } from '@/machines/shared/acorn-tape-service.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { JupiterAceMachine } from '@/machines/jupiter-ace/ace-machine.ts';
import type { CswBlock, SetLevelBlock } from '@/media/tape/tap.ts';

const RATE = 44100;
const tstates = (samples: number): number => Math.round(samples * 3_500_000 / RATE);

/** 16-bit mono PCM WAVE of `samples` (-1..1). */
function wav(samples: number[], rate = RATE): Uint8Array {
  const dataLen = samples.length * 2;
  const out = new Uint8Array(44 + dataLen);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string): void => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, dataLen, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.round(s * 32767), true));
  return out;
}

/** A square wave: alternating runs of `lengths` samples at ±amp, starting at `first`. */
function square(lengths: number[], first: 1 | -1, amp = 0.8): number[] {
  const out: number[] = [];
  lengths.forEach((n, i) => { for (let k = 0; k < n; k++) out.push((i % 2 === 0 ? first : -first) * amp); });
  return out;
}

function parts(data: Uint8Array): { level: number; pulses: number[] } {
  const [lvl, csw] = wavToPulseBlocks(data);
  return { level: (lvl as SetLevelBlock).level, pulses: [...(csw as CswBlock).pulses] };
}

describe('wavToPulseBlocks', () => {
  it('turns each run between edges into its length in 3.5MHz T-states', () => {
    const { level, pulses } = parts(wav(square([10, 20, 30, 20], 1)));
    expect(level).toBe(1);
    expect(pulses).toEqual([tstates(10), tstates(20), tstates(30), tstates(20)]);
  });

  it('starts at the polarity of the first edge', () => {
    expect(parts(wav(square([12, 12], -1))).level).toBe(0);
  });

  it('drops leading silence rather than turning it into a pulse', () => {
    const { pulses } = parts(wav([...new Array(500).fill(0), ...square([10, 10], 1)]));
    expect(pulses).toEqual([tstates(10), tstates(10)]);
  });

  it('is unmoved by a DC offset on the recording', () => {
    const offset = square([10, 20, 10, 20], 1).map(s => s + 0.15);
    expect(parts(wav(offset)).pulses).toEqual([tstates(10), tstates(20), tstates(10), tstates(20)]);
  });

  it('ignores a dip inside the hysteresis band instead of splitting the pulse', () => {
    const s = square([10, 30, 10, 30], 1);
    // Dip the middle of the first high run to zero. The recording's mean is
    // -0.4 and its peak deviation 1.2, so the falling threshold is -0.64:
    // zero is nowhere near it, and the run must stay one pulse.
    for (let i = 4; i < 6; i++) s[i] = 0;
    expect(parts(wav(s)).pulses).toEqual([tstates(10), tstates(30), tstates(10), tstates(30)]);
  });

  it('scales by the recording sample rate', () => {
    const [, csw] = wavToPulseBlocks(wav(square([48, 48], 1), 48000));
    expect([...(csw as CswBlock).pulses]).toEqual([
      Math.round(48 * 3_500_000 / 48000), Math.round(48 * 3_500_000 / 48000),
    ]);
  });

  it('refuses a silent recording', () => {
    expect(() => wavToPulseBlocks(wav(new Array(1000).fill(0)))).toThrow(/silent/);
  });

  it('refuses something that is not a WAVE file', () => {
    expect(() => wavToPulseBlocks(new Uint8Array(64))).toThrow(/WAVE/);
  });
});

describe('WAVE tapes on the machines that play pulses', () => {
  const recording = (): Uint8Array => wav(square([20, 20, 20, 20, 20, 20], 1));

  it('mount on a Spectrum as a pulse block', async () => {
    const s = new Spectrum('zx48k', null);
    expect(s.services.media.accepts().map(t => t.ext)).toContain('.wav');
    expect(await s.services.media.mount(recording(), 'game.wav')).toMatchObject({ ok: true, target: 'tape' });
    expect(s.services.tape!.rawBlocks.some(b => b.kind === 'csw')).toBe(true);
  });

  it('mount on a CPC as a pulse block', async () => {
    const c = new CpcMachine('cpc6128', null);
    expect(c.services.media.accepts().map(t => t.ext)).toContain('.wav');
    expect(await c.services.media.mount(recording(), 'game.wav')).toMatchObject({ ok: true, target: 'tape' });
    expect(c.services.tape!.rawBlocks.some(b => b.kind === 'csw')).toBe(true);
  });

  // A page reload restores the saved tape through mountBytes, not mount: it
  // must read the bytes as a recording too, not as a .tap of nonsense blocks.
  it.each([
    ['Spectrum', () => new Spectrum('zx48k', null)],
    ['CPC', () => new CpcMachine('cpc6128', null)],
    ['Jupiter Ace', () => new JupiterAceMachine('jupiter-ace', null)],
  ] as const)('come back as a pulse block when the %s restores them on reload', async (_name, create) => {
    const m = create();
    expect(await m.services.tape!.mountBytes(recording(), 'game.wav')).toBe(true);
    expect(m.services.tape!.rawBlocks.map(b => b.kind)).toEqual(['set-level', 'csw']);
  });

  it('a corrupt .wav is refused with a message, not mounted', async () => {
    const s = new Spectrum('zx48k', null);
    const r = await s.services.media.mount(new Uint8Array(64), 'junk.wav');
    expect(r.ok).toBe(false);
    expect(s.services.tape!.rawBlocks).toHaveLength(0);
  });

  it('are recognised by the Acorn tape parser by content, not by name', async () => {
    const blocks = await parseAcornTape(recording());
    expect(blocks.map(b => b.kind)).toEqual(['set-level', 'csw']);
  });
});
