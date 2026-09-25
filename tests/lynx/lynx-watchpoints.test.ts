/** Debugger memory and port watchpoints on the Lynx bus. */

import { describe, it, expect } from 'vitest';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';

function machineRunning(code: number[]): LynxMachine {
  const rom = new Uint8Array(0x4000);
  rom.set(code, 0);
  const m = new LynxMachine('lynx48', null);
  m.loadROM(rom);
  m.reset();
  return m;
}

const PROGRAM = [
  0x3a, 0x00, 0x90,   // 0000 LD A,(9000h)
  0x3e, 0x12,         // 0003 LD A,12h
  0x32, 0x01, 0x90,   // 0005 LD (9001h),A
  0xd3, 0x84,         // 0008 OUT (84h),A   -> port 1284h
  0x18, 0xfe,         // 000A JR $
];

describe('Lynx watchpoints', () => {
  it('stops on a memory read watchpoint after the reading instruction', () => {
    const m = machineRunning(PROGRAM);
    m.memWatchpoints.push({ start: 0x9000, end: 0x9000, mode: 'read' });
    m.tick();
    expect(m.memWatchHit).toEqual({ addr: 0x9000, value: 0, dir: 'read' });
    expect(m.cpu.pc).toBe(0x0003);
  });

  it('stops on a memory write watchpoint with the value written', () => {
    const m = machineRunning(PROGRAM);
    m.memWatchpoints.push({ start: 0x9001, end: 0x9001, mode: 'write' });
    m.tick();
    expect(m.memWatchHit).toEqual({ addr: 0x9001, value: 0x12, dir: 'write' });
    expect(m.cpu.pc).toBe(0x0008);
  });

  it('ignores accesses in the other direction', () => {
    const m = machineRunning(PROGRAM);
    m.memWatchpoints.push({ start: 0x9001, end: 0x9001, mode: 'read' });
    m.tick();
    expect(m.memWatchHit).toBeNull();
  });

  it('stops on a port watchpoint for the full 16-bit port', () => {
    const m = machineRunning(PROGRAM);
    m.portWatchpoints.add(0x1284);
    m.tick();
    expect(m.portWatchHit).toEqual({ port: 0x1284, value: 0x12, dir: 'out' });
    expect(m.cpu.pc).toBe(0x000a);
  });
});
