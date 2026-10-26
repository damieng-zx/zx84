/**
 * The beam on every machine (docs/beam-debug-mcp-spec.md P1, P3): each family
 * reports a beam position and its geometry, logs interrupts, and can stop in
 * the middle of a frame — at a raster position or on a trap — and carry the
 * frame on, so that stopping and continuing leaves the machine exactly where
 * an uninterrupted run would.
 *
 * No ROM is loaded: a Z80 machine with empty memory runs NOPs and a 6502 one
 * runs BRKs through a zero vector, which is enough to drive the frame loops.
 */

import { describe, it, expect } from 'vitest';
import { registry } from '@/machines/registry.ts';
import { BeamLog, BEAM_IO } from '@/debug/beam-log.ts';
import type { Machine } from '@/machines/machine.ts';

const FAMILIES = registry.map(entry => ({ kind: entry.kind, model: entry.models[0], entry }));

/** Everything a stop and resume must leave as an uninterrupted run would. */
function fingerprint(m: Machine) {
  const dbg = m.services.debug;
  return { t: dbg.tStates, pc: dbg.pc, frame: m.frameNumber, memory: Array.from(m.memory.snapshot()) };
}

describe.each(FAMILIES)('beam on $kind ($model)', ({ model, entry }) => {
  function boot(): Machine {
    const m = entry.create(model, null);
    m.reset();
    return m;
  }
  /** Run until `frames` whole frames have completed since reset. */
  function runTo(m: Machine, frames: number): void {
    for (let guard = 0; m.frameNumber < frames && guard < 1000; guard++) m.runUntil(1);
  }

  it('reports a beam, its geometry, interrupt logging and beam stops', () => {
    const m = boot();
    try {
      const info = m.beamInfo();
      expect(info).not.toBeNull();
      expect(info!.cyclesPerLine).toBeGreaterThan(0);
      expect(info!.linesPerFrame).toBeGreaterThan(0);
      expect(m.supportsBeamStops()).toBe(true);
      expect(m.supportsInterruptLog()).toBe(true);
      expect(m.beam()).toEqual({ frame: 0, t: 0 });
      m.runUntil(3);
      const pos = m.beam()!;
      expect(pos.frame).toBe(3);
      // Between frames the beam is a few cycles into the next one.
      expect(pos.t).toBeGreaterThanOrEqual(0);
      expect(pos.t).toBeLessThan(info!.cyclesPerLine);
    } finally { m.destroy(); }
  });

  it('a run to a raster position stops there mid-frame and resumes as if never stopped', () => {
    const a = boot();
    const b = boot();
    try {
      runTo(a, 4);
      const info = b.beamInfo()!;
      const target = { frame: 2, t: Math.floor(info.linesPerFrame / 2) * info.cyclesPerLine + 7 };
      b.beamTarget = target;
      b.runUntil(10);
      expect(b.stopReason?.kind).toBe('beam');
      expect(b.beamTarget).toBeNull();
      const at = b.beam()!;
      expect(at.frame).toBe(2);
      expect(at.t).toBeGreaterThanOrEqual(target.t);
      expect(at.t).toBeLessThan(target.t + info.cyclesPerLine);
      runTo(b, 4);
      expect(fingerprint(b)).toEqual(fingerprint(a));
    } finally { a.destroy(); b.destroy(); }
  });

  it('a trap stop mid-frame resumes as if never stopped, and counts the frame once', () => {
    const a = boot();
    const b = boot();
    try {
      runTo(a, 3);
      let calls = 0;
      b.onTrap = (_pc, resume) => !resume && ++calls === 2000;
      b.runUntil(10);
      expect(b.stopReason?.kind).toBe('trap');
      const stoppedFrame = b.frameNumber;
      expect(b.beam()!.frame).toBe(stoppedFrame);
      b.onTrap = null;
      runTo(b, 3);
      expect(fingerprint(b)).toEqual(fingerprint(a));
    } finally { a.destroy(); b.destroy(); }
  });

  it('logged accesses are stamped inside the frame they happen in', () => {
    const m = boot();
    try {
      const info = m.beamInfo()!;
      m.beamLog = new BeamLog(1000);
      m.memWatchpoints.push({ start: 0, end: 0xFFFF, mode: 'rw', action: 'log' });
      m.runUntil(2);
      const log = m.beamLog;
      const frameCycles = info.cyclesPerLine * info.linesPerFrame;
      let last = -1;
      for (let i = 0; i < log.length; i++) {
        const e = log.get(i);
        expect(e.kind).toBe(BEAM_IO);
        expect(e.t).toBeGreaterThanOrEqual(0);
        // An instruction that crosses the end of a frame is stamped in it.
        expect(e.t).toBeLessThan(frameCycles + 64);
        const at = e.frame * frameCycles * 2 + e.t;
        expect(at).toBeGreaterThanOrEqual(last);
        last = at;
      }
      expect(m.stopReason).toBeNull();
    } finally { m.destroy(); }
  });
});
