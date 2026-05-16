import { describe, it, expect } from 'vitest';
import { Z80 } from '@/cores/z80.ts';

describe('Z80 — interruptWithVector _pendingVector handling', () => {
  it('resets _pendingVector when interrupt is blocked by IFF1=0', () => {
    const cpu = new Z80();
    cpu.im = 2;
    cpu.iff1 = false;

    const result = cpu.interruptWithVector(0x10);

    expect(result).toBe(0);
    expect(cpu._pendingVector).toBe(0xFF);
  });

  it('resets _pendingVector when interrupt is blocked by eiDelay', () => {
    const cpu = new Z80();
    cpu.im = 2;
    cpu.iff1 = true;
    cpu.eiDelay = true;

    const result = cpu.interruptWithVector(0x20);

    expect(result).toBe(0);
    expect(cpu._pendingVector).toBe(0xFF);
  });

  it('does not corrupt a subsequent frame interrupt after a blocked AMX interrupt', () => {
    const cpu = new Z80();
    cpu.im = 2;
    cpu.iff1 = false;
    cpu.i = 0x40;

    cpu.interruptWithVector(0x10);
    expect(cpu._pendingVector).toBe(0xFF);

    cpu.iff1 = true;
    cpu.interrupt();
    expect(cpu.pc).toBe(0xFFFF);
  });

  it('uses the correct vector when interrupt fires immediately', () => {
    const cpu = new Z80();
    cpu.im = 2;
    cpu.iff1 = true;
    cpu.i = 0x40;
    cpu.sp = 0xFFFF;

    const tStates = cpu.interruptWithVector(0x10);

    expect(tStates).toBe(19);
    expect(cpu._pendingVector).toBe(0xFF);
  });
});
