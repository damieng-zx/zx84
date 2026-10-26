/**
 * Stop handling in every machine's frame loop (docs/beam-debug-mcp-spec.md P2).
 * A breakpoint or a break trap must end a run with its reason, and resuming
 * from it must make progress instead of stopping at the same pc again: the
 * loops of the BBC, Electron, Apple I/II and the Z80 machines used to ignore a
 * break trap's stop, and every one but the Atari and Spectrum re-hit a stop on
 * resume. They share `BaseMachine.checkStops` now.
 *
 * No ROM is loaded: a machine with empty memory runs zeros, and the first
 * instruction after a reset is at the reset pc, which is all this needs.
 */

import { describe, it, expect } from 'vitest';
import { registry } from '@/machines/registry.ts';

const FAMILIES = registry.map(entry => ({ kind: entry.kind, model: entry.models[0], entry }));

describe.each(FAMILIES)('stops on $kind ($model)', ({ model, entry }) => {
  function boot() {
    const m = entry.create(model, null);
    m.reset();
    return m;
  }

  it('a break trap ends the run, and a resume tells the trap so and makes progress', () => {
    const m = boot();
    try {
      const pc0 = m.services.debug.pc;
      const calls: Array<[number, boolean]> = [];
      m.onTrap = (pc, resume) => {
        if (pc === pc0) calls.push([pc, resume === true]);
        return pc === pc0 && !resume;
      };
      expect(m.runUntil(1)).toBe(1);
      expect(m.stopReason).toEqual({ kind: 'trap', pc: pc0, detail: '' });
      expect(m.breakpointHit).toBe(pc0);
      const stoppedAt = m.services.debug.tStates;
      m.runUntil(1);
      // The first thing the resumed run does is let the trap know it is a resume...
      expect(calls[0]).toEqual([pc0, false]);
      expect(calls[1]).toEqual([pc0, true]);
      // ...and the machine then runs: time moves on instead of standing still at the stop.
      expect(m.services.debug.tStates).toBeGreaterThan(stoppedAt);
    } finally { m.destroy(); }
  });

  it('a breakpoint ends the run, and a resume steps over it', () => {
    const m = boot();
    try {
      const pc0 = m.services.debug.pc;
      m.breakpoints.add(pc0);
      expect(m.runUntil(1)).toBe(1);
      expect(m.stopReason).toEqual({ kind: 'breakpoint', pc: pc0, detail: '' });
      const stoppedAt = m.services.debug.tStates;
      m.runUntil(1);
      expect(m.services.debug.tStates).toBeGreaterThan(stoppedAt);
    } finally { m.destroy(); }
  });

  it('a run with nothing armed has no stop reason', () => {
    const m = boot();
    try {
      m.tick();
      expect(m.stopReason).toBeNull();
      expect(m.breakpointHit).toBe(-1);
    } finally { m.destroy(); }
  });
});
