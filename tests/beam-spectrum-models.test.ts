/**
 * The beam geometry of every Spectrum model (docs/beam-debug-mcp-spec.md P1):
 * line length, lines a frame and where the first display pixel falls. Each model
 * takes its figures from its timing table, so this pins the table to the model.
 * The display start is `t` from the frame interrupt; "line:col" is that `t` as
 * a line and a cycle in it.
 */

import { describe, it, expect } from 'vitest';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import type { SpectrumModel } from '@/machines/spectrum/models.ts';
import { BeamLog } from '@/debug/beam-log.ts';
import { beamHeader } from '../mcp/beam.ts';

const MODELS: ReadonlyArray<{
  model: SpectrumModel; cpl: number; lines: number; start: number; at: string; verified: boolean;
}> = [
  { model: 'zx16k',        cpl: 224, lines: 312, start: 14336, at: '64:0',   verified: true },
  { model: 'zx48k',        cpl: 224, lines: 312, start: 14336, at: '64:0',   verified: true },
  { model: 'zx128k',       cpl: 228, lines: 311, start: 14362, at: '62:226', verified: true },
  { model: 'zx128kplus2',  cpl: 228, lines: 311, start: 14362, at: '62:226', verified: true },
  { model: 'zx128kplus2a', cpl: 228, lines: 311, start: 14364, at: '63:0',   verified: true },
  { model: 'zx128kplus3',  cpl: 228, lines: 311, start: 14364, at: '63:0',   verified: true },
  { model: 'pentagon128',  cpl: 224, lines: 320, start: 17988, at: '80:68',  verified: false },
  { model: 'pentagon512',  cpl: 224, lines: 320, start: 17988, at: '80:68',  verified: false },
  { model: 'pentagon1024', cpl: 224, lines: 320, start: 17988, at: '80:68',  verified: false },
  { model: 'scorpion256',  cpl: 224, lines: 312, start: 14344, at: '64:8',   verified: false },
];

describe.each(MODELS)('Spectrum $model beam geometry', ({ model, cpl, lines, start, at, verified }) => {
  it('has the line length, frame length and display start of its timing table', () => {
    const s = new Spectrum(model, null);
    try {
      const info = s.beamInfo();
      expect(info.cyclesPerLine).toBe(cpl);
      expect(info.linesPerFrame).toBe(lines);
      expect(info.displayStart).toBe(start);
      expect(`${Math.floor(start / cpl)}:${start % cpl}`).toBe(at);
      // A frame is a whole number of lines, and it is the one the machine runs.
      expect(info.cyclesPerLine * info.linesPerFrame).toBe(s.tStatesPerFrame);
    } finally { s.destroy(); }
  });

  it(verified ? 'carries no caveat' : 'says its display start is not hardware-verified', () => {
    const s = new Spectrum(model, null);
    try {
      const header = beamHeader(s, new BeamLog(4), { relDisplay: false });
      expect(header).toContain(`display starts at t=${start} (line ${at.split(':')[0]}, cycle ${at.split(':')[1]})`);
      if (verified) {
        expect(s.beamInfo().note).toBeUndefined();
        expect(header).not.toContain('Note:');
      } else {
        expect(s.beamInfo().note).toMatch(/not hardware-verified/);
        expect(header).toMatch(/Note: .*not hardware-verified/);
      }
    } finally { s.destroy(); }
  });
});
