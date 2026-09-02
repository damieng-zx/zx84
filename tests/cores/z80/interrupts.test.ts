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
    // instruction's M1 cycle still rejects them. step() itself resets
    // eiDelay to false before every instruction and lets EI's own opcode
    // handler set it back to true, so the flag survives exactly one
    // instruction with no run-loop bookkeeping required.
    const h = newCpu();
    load(h.mem, 0, 0xFB, 0x00); // EI ; NOP
    step(h); // EI
    expect(h.cpu.iff1).toBe(true);
    expect(h.cpu.eiDelay).toBe(true);
    expect(h.cpu.interrupt()).toBe(0); // blocked
    step(h); // NOP
    expect(h.cpu.eiDelay).toBe(false); // step() cleared it on its own
    expect(h.cpu.interrupt()).toBeGreaterThan(0);
  });

  it('EI;EI;X keeps interrupts blocked through both EIs, not just the first', () => {
    // Each EI re-arms its own one-instruction suppression window. A run of
    // EI;EI;X must stay blocked through the second EI too, and only accept
    // an interrupt once X has executed — not in the gap right after the
    // second EI (the bug: a run loop that only tracked "was eiDelay already
    // true before this step" wiped out the second EI's fresh re-arm).
    const h = newCpu();
    load(h.mem, 0, 0xFB, 0xFB, 0x00); // EI ; EI ; NOP
    step(h); // 1st EI
    expect(h.cpu.eiDelay).toBe(true);
    expect(h.cpu.interrupt()).toBe(0); // blocked after EI #1
    step(h); // 2nd EI
    expect(h.cpu.eiDelay).toBe(true);  // re-armed, not cleared
    expect(h.cpu.interrupt()).toBe(0); // still blocked after EI #2
    step(h); // NOP (X)
    expect(h.cpu.eiDelay).toBe(false);
    expect(h.cpu.interrupt()).toBeGreaterThan(0); // accepted only now
  });

  it('HALT is itself the one suppressed instruction after EI, so EI;HALT accepts interrupts right away', () => {
    // step()'s reset runs before the halted check too, so it applies whether
    // an instruction transitions into HALT or re-fetches while already
    // halted. HALT's own fetch cycle satisfies "one instruction after EI",
    // so interrupts are already accepted from the very next sampling point —
    // no extra re-fetch needed, matching the common "EI ; HALT" idle-wait idiom.
    // (Inspecting eiDelay directly rather than calling interrupt() along the
    // way — interrupt() mutates halted/iff1 on acceptance.)
    const h = newCpu();
    load(h.mem, 0, 0xFB, 0x76); // EI ; HALT
    step(h); // EI
    expect(h.cpu.eiDelay).toBe(true); // suppressed right after EI
    step(h); // HALT — the suppressed instruction; transitions into halted
    expect(h.cpu.halted).toBe(true);
    expect(h.cpu.eiDelay).toBe(false); // already un-suppressed
    // A subsequent re-fetch on the already-halted fast path must not
    // reintroduce stale suppression either.
    step(h);
    expect(h.cpu.halted).toBe(true);
    expect(h.cpu.eiDelay).toBe(false);
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

  it('NMI jumps to $66, clears IFF1, and leaves IFF2 untouched', () => {
    // Real hardware does NOT copy IFF1 into IFF2 on NMI entry — only RETN's
    // IFF1 <- IFF2 touches IFF2. Confirmed here with IFF1/IFF2 starting at
    // different values: a copy-on-entry bug would make them equal.
    const h = newCpu();
    h.cpu.iff1 = true; h.cpu.iff2 = false;
    h.cpu.pc = 0x500; h.cpu.sp = 0xC010;
    h.cpu.nmi();
    expect(h.cpu.pc).toBe(0x66);
    expect(h.cpu.iff1).toBe(false);
    expect(h.cpu.iff2).toBe(false); // untouched, not copied from the pre-NMI IFF1
    expect(h.mem[0xC00E]).toBe(0x00);
    expect(h.mem[0xC00F]).toBe(0x05);
  });

  it('a nested NMI does not corrupt IFF2, so RETN restores the true pre-NMI state', () => {
    // A second NMI firing before the first's RETN must not stomp IFF2 with
    // IFF1's current (already-cleared-by-the-first-NMI) value — that would
    // permanently mask maskable interrupts once RETN eventually runs.
    const h = newCpu();
    h.cpu.iff1 = true; h.cpu.iff2 = true; // pre-NMI: maskable interrupts enabled
    h.cpu.nmi(); // first NMI: iff1 -> false, iff2 untouched (still true)
    expect(h.cpu.iff1).toBe(false);
    expect(h.cpu.iff2).toBe(true);
    h.cpu.nmi(); // nested NMI: iff1 already false, must still leave iff2 alone
    expect(h.cpu.iff1).toBe(false);
    expect(h.cpu.iff2).toBe(true); // still true — RETN can restore it correctly
  });
});

describe('Z80 — R register on interrupt acknowledge', () => {
  // The INT/NMI acknowledge is an M1 cycle, so R increments exactly as it
  // does for an opcode fetch: low 7 bits advance, bit 7 is preserved.
  it('accepted maskable interrupt increments R by 1', () => {
    const h = newCpu();
    h.cpu.iff1 = true; h.cpu.im = 1; h.cpu.r = 0x10;
    expect(h.cpu.interrupt()).toBe(13);
    expect(h.cpu.r).toBe(0x11);
  });

  it('R bit 7 is preserved across the wrap at 0x7F', () => {
    const h = newCpu();
    h.cpu.iff1 = true; h.cpu.im = 1;
    h.cpu.r = 0x7F; // bit 7 clear: wraps to 0x00
    h.cpu.interrupt();
    expect(h.cpu.r).toBe(0x00);
    h.cpu.iff1 = true;
    h.cpu.r = 0xFF; // bit 7 set: wraps to 0x80
    h.cpu.interrupt();
    expect(h.cpu.r).toBe(0x80);
  });

  it('blocked interrupt (IFF1=0) does not touch R', () => {
    const h = newCpu();
    h.cpu.iff1 = false; h.cpu.r = 0x10;
    expect(h.cpu.interrupt()).toBe(0);
    expect(h.cpu.r).toBe(0x10);
  });

  it('NMI increments R by 1', () => {
    const h = newCpu();
    h.cpu.r = 0x10;
    h.cpu.nmi();
    expect(h.cpu.r).toBe(0x11);
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
