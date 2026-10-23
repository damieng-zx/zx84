/**
 * BeamLog: the machine-owned ring of beam-stamped events. It must keep events
 * in the order they were recorded, count what falls off the end, and apply its
 * capture filters before anything is stored.
 */

import { describe, it, expect } from 'vitest';
import {
  BeamLog, BEAM_IO, BEAM_PC, BEAM_IRQ, parseBeamRange,
} from '@/debug/beam-log.ts';

describe('BeamLog', () => {
  it('returns entries oldest first, with every column', () => {
    const log = new BeamLog(8);
    log.push(BEAM_PC, 3, 100, 0x1273, 0, 0, 0, 7, 9);
    log.push(BEAM_IO, 3, 101, 0x1259, 0xD404, 0x03, 1);
    expect(log.length).toBe(2);
    expect(log.get(0)).toEqual({
      kind: BEAM_PC, frame: 3, t: 100, pc: 0x1273, addr: 0, value: 0, flags: 0, regLo: 7, regHi: 9,
    });
    expect(log.get(1)).toMatchObject({ kind: BEAM_IO, t: 101, addr: 0xD404, value: 3, flags: 1 });
  });

  it('keeps events that share a t in the order they were pushed', () => {
    const log = new BeamLog(8);
    log.push(BEAM_IO, 0, 50, 1);
    log.push(BEAM_PC, 0, 50, 2);
    log.push(BEAM_IRQ, 0, 50, 3);
    expect([0, 1, 2].map(i => log.get(i).pc)).toEqual([1, 2, 3]);
  });

  it('wraps, loses the oldest entries and counts them', () => {
    const log = new BeamLog(4);
    for (let i = 0; i < 10; i++) log.push(BEAM_PC, 0, i, i);
    expect(log.length).toBe(4);
    expect(log.dropped).toBe(6);
    expect([0, 1, 2, 3].map(i => log.get(i).t)).toEqual([6, 7, 8, 9]);
  });

  it('clear() empties the ring and resets the dropped count', () => {
    const log = new BeamLog(2);
    for (let i = 0; i < 5; i++) log.push(BEAM_PC, 0, i);
    log.clear();
    expect(log.length).toBe(0);
    expect(log.dropped).toBe(0);
    log.push(BEAM_PC, 0, 99);
    expect(log.get(0).t).toBe(99);
  });

  it('applies the frame and line filters at capture time', () => {
    const log = new BeamLog(16);
    log.setFilter({ min: 10, max: 11 }, { min: 8, max: 40 }, 114);
    expect(log.push(BEAM_PC, 9, 114 * 20)).toBe(false);     // frame too early
    expect(log.push(BEAM_PC, 12, 114 * 20)).toBe(false);    // frame too late
    expect(log.push(BEAM_PC, 10, 114 * 7 + 113)).toBe(false); // line 7
    expect(log.push(BEAM_PC, 10, 114 * 41)).toBe(false);    // line 41
    expect(log.push(BEAM_PC, 10, 114 * 8)).toBe(true);      // line 8, cycle 0
    expect(log.push(BEAM_PC, 11, 114 * 40 + 113)).toBe(true); // line 40, last cycle
    expect(log.length).toBe(2);
    expect(log.dropped).toBe(0);
  });

  it('accepts everything when no filter is set', () => {
    const log = new BeamLog(4);
    expect(log.accepts(123456, 99999)).toBe(true);
  });
});

describe('parseBeamRange', () => {
  it('parses a range, a single value and open ends', () => {
    expect(parseBeamRange('1500-1510')).toEqual({ min: 1500, max: 1510 });
    expect(parseBeamRange('42')).toEqual({ min: 42, max: 42 });
    expect(parseBeamRange('8-')).toEqual({ min: 8, max: Infinity });
    expect(parseBeamRange('-40')).toEqual({ min: 0, max: 40 });
  });

  it('returns null for nothing or nonsense', () => {
    expect(parseBeamRange(undefined)).toBeNull();
    expect(parseBeamRange('')).toBeNull();
    expect(parseBeamRange('abc')).toBeNull();
  });
});
