/** The shared watchpoint recorders on BaseMachine, which every machine's bus wiring calls. */

import { describe, it, expect } from 'vitest';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';

const machine = (): LynxMachine => new LynxMachine('lynx48', null);

describe('recordMemWatch', () => {
  it('matches both ends of the range inclusively', () => {
    const m = machine();
    m.memWatchpoints.push({ start: 0x4000, end: 0x40ff, mode: 'rw' });
    m.recordMemWatch(0x3fff, 1, 'read');
    expect(m.memWatchHit).toBeNull();
    m.recordMemWatch(0x4100, 1, 'read');
    expect(m.memWatchHit).toBeNull();
    m.recordMemWatch(0x4000, 2, 'read');
    expect(m.memWatchHit).toEqual({ addr: 0x4000, value: 2, dir: 'read' });
    m.memWatchHit = null;
    m.recordMemWatch(0x40ff, 3, 'write');
    expect(m.memWatchHit).toEqual({ addr: 0x40ff, value: 3, dir: 'write' });
  });

  it('ignores an access in the direction the watchpoint is not set for', () => {
    const m = machine();
    m.memWatchpoints.push({ start: 0x5000, end: 0x5000, mode: 'write' });
    m.recordMemWatch(0x5000, 7, 'read');
    expect(m.memWatchHit).toBeNull();
    m.recordMemWatch(0x5000, 7, 'write');
    expect(m.memWatchHit).toEqual({ addr: 0x5000, value: 7, dir: 'write' });
  });

  it('reports the access direction, not the watchpoint mode, for an rw watchpoint', () => {
    const m = machine();
    m.memWatchpoints.push({ start: 0x6000, end: 0x6000, mode: 'rw' });
    m.recordMemWatch(0x6000, 9, 'write');
    expect(m.memWatchHit?.dir).toBe('write');
  });

  it('is satisfied by any one of several watchpoints', () => {
    const m = machine();
    m.memWatchpoints.push({ start: 0x1000, end: 0x1000, mode: 'read' });
    m.memWatchpoints.push({ start: 0x2000, end: 0x2fff, mode: 'read' });
    m.recordMemWatch(0x2800, 5, 'read');
    expect(m.memWatchHit).toEqual({ addr: 0x2800, value: 5, dir: 'read' });
  });
});

describe('recordPortWatch', () => {
  it('records only a watched port, with its value and direction', () => {
    const m = machine();
    m.portWatchpoints.add(0x00fe);
    m.recordPortWatch(0x00ff, 1, 'in');
    expect(m.portWatchHit).toBeNull();
    m.recordPortWatch(0x00fe, 0xa5, 'out');
    expect(m.portWatchHit).toEqual({ port: 0x00fe, value: 0xa5, dir: 'out' });
  });

  it('keeps the first hit when a second watched access follows', () => {
    const m = machine();
    m.portWatchpoints.add(0x00fe);
    m.recordPortWatch(0x00fe, 1, 'in');
    m.recordPortWatch(0x00fe, 2, 'out');
    expect(m.portWatchHit).toEqual({ port: 0x00fe, value: 1, dir: 'in' });
  });
});
