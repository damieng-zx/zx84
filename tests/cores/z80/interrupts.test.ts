/**
 * Z80 interrupt tests — IM modes, NMI, interruptWithVector,
 * _pendingVector lifecycle.
 */
import { describe, it, expect } from 'vitest';
import { Z80 } from '@/cores/z80.ts';
import { newCpu, load, step } from './_harness.ts';

describe('Z80 — Interrupt modes', () => {
  it('IM 1 fires RST 38h and clears IFF1/IFF2', () => {
    const h = newCpu();
    h.cpu.iff1 = true; h.cpu.iff2 = true; h.cpu.im = 1;
    h.cpu.sp = 0xC010; h.cpu.pc = 0x1234;
    const t = h.cpu.interrupt();
    expect(t).toBeGreaterThan(0);
    expect(h.cpu.pc).toBe(0x38);
    expect(h.cpu.iff1).toBe(false);
    expect(h.cpu.iff2).toBe(false);
    expect(h.mem[0xC00E]).toBe(0x34);
    expect(h.mem[0xC00F]).toBe(0x12);
  });

  it('interrupt blocked when IFF1=0', () => {
    const h = newCpu();
    h.cpu.iff1 = false; h.cpu.pc = 0x100;
    const t = h.cpu.interrupt();
    expect(t).toBe(0);
    expect(h.cpu.pc).toBe(0x100); // untouched
  });

  it('EI sets eiDelay so an interrupt during the next M1 is blocked', () => {
    // Documented Zilog behaviour: EI enables interrupts but the *next*
    // instruction's M1 cycle still rejects them. In this core, eiDelay is set
    // by EI and the surrounding run loop (io-ports.ts / spectrum.ts) clears
    // it after the next instruction executes — step() alone does not.
    const h = newCpu();
    load(h.mem, 0, 0xFB, 0x00); // EI ; NOP
    step(h); // EI
    expect(h.cpu.iff1).toBe(true);
    expect(h.cpu.eiDelay).toBe(true);
    expect(h.cpu.interrupt()).toBe(0); // blocked
    step(h); // NOP
    h.cpu.eiDelay = false;
    expect(h.cpu.interrupt()).toBeGreaterThan(0);
  });

  it('IM 2 vectors via I:vector and pushes return address', () => {
    const h = newCpu();
    h.cpu.iff1 = true; h.cpu.im = 2;
    h.cpu.i = 0x40; h.cpu.pc = 0xABCD; h.cpu.sp = 0xC010;
    h.mem[0x40FE] = 0x00; h.mem[0x40FF] = 0x80; // standard frame vector $FF
    h.mem[0x40FF] = 0x34; h.mem[0x4100] = 0x12;
    h.cpu.interrupt();
    expect(h.cpu.pc).toBe(0x1234);
    expect(h.mem[0xC00E]).toBe(0xCD);
    expect(h.mem[0xC00F]).toBe(0xAB);
  });

  it('NMI jumps to $66 and saves IFF1 into IFF2 (IFF1 cleared)', () => {
    const h = newCpu();
    h.cpu.iff1 = true; h.cpu.iff2 = false;
    h.cpu.pc = 0x500; h.cpu.sp = 0xC010;
    h.cpu.nmi();
    expect(h.cpu.pc).toBe(0x66);
    expect(h.cpu.iff1).toBe(false);
    expect(h.cpu.iff2).toBe(true);
    expect(h.mem[0xC00E]).toBe(0x00);
    expect(h.mem[0xC00F]).toBe(0x05);
  });
});

describe('Z80 — interruptWithVector(vector)', () => {
  it('returns 0 and clears pending vector when blocked by IFF1', () => {
    const h = newCpu();
    h.cpu.im = 2;
    h.cpu.iff1 = false;
    expect(h.cpu.interruptWithVector(0x10)).toBe(0);
    expect(h.cpu._pendingVector).toBe(0xFF);
  });
});

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
