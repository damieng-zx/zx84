/**
 * Tests for DebugManager.
 *
 * Lock-ins for previously-fragile behaviour:
 *  - stepOver runs block repeats (LDIR/LDDR/CPIR/CPDR/INIR/INDR/OTIR/OTDR)
 *    to completion via PC-based termination, not SP-based. Pre-fix the
 *    detection mask was unsatisfiable, so block repeats single-stepped one
 *    iteration and rewound.
 *  - copyCpuState awaits the clipboard write and reports failures via
 *    onStatus, instead of fire-and-forget with a misleading "copied" status.
 *  - stopTrace reports 0 lines for empty trace text (was 1 via the
 *    '' .split('\n') artefact).
 *
 * Outstanding smells documented (not asserted as correct):
 *  - Divergent taken JR cc / JP cc spins to the 5M-tState safety limit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DebugManager } from '@/managers/debug-manager.ts';
import { Z80 } from '@/cores/z80.ts';
import type { Spectrum } from '@/spectrum.ts';

// ── Spectrum stub with a real Z80 backed by a flat 64KB array ─────────────

// Stub is fully Spectrum-typed for dm.*() calls; mem is exposed for setup.
// Mock-method accesses (e.g. .toHaveBeenCalled()) go via vi.mocked() so the
// underlying Spectrum signature can stay strict.
type StubSpectrum = Spectrum & { mem: Uint8Array };

function makeStub(): StubSpectrum {
  const mem = new Uint8Array(0x10000);
  const cpu = new Z80();
  cpu.read8 = (a: number) => mem[a & 0xFFFF]!;
  cpu.write8 = (a: number, v: number) => { mem[a & 0xFFFF] = v & 0xFF; };

  const stub = {
    cpu,
    mem,
    memory: {
      readByte: (a: number) => mem[a & 0xFFFF]!,
      writeByte: (a: number, v: number) => { mem[a & 0xFFFF] = v & 0xFF; },
      snapshot: () => mem.slice(),
    },
    breakpoints: new Set<number>(),
    start: vi.fn(),
    tick: vi.fn(),
    startTrace: vi.fn(),
    stopTrace: vi.fn(() => 'a\nb\nc'),
    display: null,
    // The Machine frame buffer surface used by stepFrame's display refresh.
    pixels: new Uint8Array(8),
  };
  return stub as unknown as StubSpectrum;
}

// ── stepInto ─────────────────────────────────────────────────────────────

describe('DebugManager.stepInto', () => {
  it('executes one instruction and fires the update callback', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // NOP at PC=0 → PC becomes 1.
    s.mem[0] = 0x00;
    const onUpdate = vi.fn();
    dm.stepInto(s, onUpdate);
    expect(s.cpu.pc).toBe(1);
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('halted CPU with interrupts DISABLED: stepInto spins the HALT (no INT to wake it)', () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.mem[0] = 0x76; // HALT — iff1 defaults to false (DI)
    dm.stepInto(s, vi.fn()); // executes HALT: halted=true
    expect(s.cpu.halted).toBe(true);
    const pcAfterHalt = s.cpu.pc;
    const tAfterHalt = s.cpu.tStates;
    dm.stepInto(s, vi.fn()); // re-runs the HALT NOP cycle (can't fire INT)
    expect(s.cpu.halted).toBe(true);
    expect(s.cpu.pc).toBe(pcAfterHalt); // PC does not advance while halted
    expect(s.cpu.tStates).toBe(tAfterHalt + 4); // costs 4 T-states per cycle
  });

  it('halted CPU with interrupts ENABLED: stepInto enters the IM1 handler', () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.cpu.sp = 0x8000;
    s.cpu.iff1 = true;
    s.cpu.im = 1;
    s.mem[0] = 0x76; // HALT
    dm.stepInto(s, vi.fn());            // execute HALT → halted, PC parked past it
    expect(s.cpu.halted).toBe(true);
    const ret = s.cpu.pc;              // return address pushed by the interrupt
    dm.stepInto(s, vi.fn());            // should fire the frame interrupt
    expect(s.cpu.halted).toBe(false);
    expect(s.cpu.pc).toBe(0x0038);     // IM1 vector
    expect(s.cpu.iff1).toBe(false);    // INT acknowledge disables further INTs
    expect(s.cpu.sp).toBe(0x7FFE);     // return address pushed
    expect(s.mem[0x7FFE]).toBe(ret & 0xFF);
    expect(s.mem[0x7FFF]).toBe((ret >> 8) & 0xFF);
  });

  it('halted CPU in IM2: stepInto vectors through the table to the handler', () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.cpu.sp = 0x8000;
    s.cpu.iff1 = true;
    s.cpu.im = 2;
    s.cpu.i = 0xFE;                    // vector table page; bus vector defaults to 0xFF
    s.mem[0xFEFF] = 0x27;             // handler 0x9227, low byte at (I<<8)|0xFF
    s.mem[0xFF00] = 0x92;             // high byte at the next address
    s.mem[0] = 0x76;                  // HALT
    dm.stepInto(s, vi.fn());           // execute HALT → halted
    dm.stepInto(s, vi.fn());           // fire IM2 interrupt
    expect(s.cpu.halted).toBe(false);
    expect(s.cpu.pc).toBe(0x9227);
  });

  it('halted CPU with interrupts ENABLED: stepOver also enters the handler', () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.cpu.sp = 0x8000;
    s.cpu.iff1 = true;
    s.cpu.im = 1;
    s.mem[0] = 0x76; // HALT
    dm.stepInto(s, vi.fn());            // halt
    dm.stepOver(s, vi.fn());            // stepOver on a HALT → into the interrupt
    expect(s.cpu.halted).toBe(false);
    expect(s.cpu.pc).toBe(0x0038);
  });
});

// ── stepOver: simple, CALL/RET, conditional jumps, block repeats ─────────

describe('DebugManager.stepOver', () => {
  it('single-steps an ordinary instruction (LD A,n)', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // LD A, 0x42 at 0; NOP at 2.
    s.mem.set([0x3E, 0x42, 0x00], 0);
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(2);
    expect(s.cpu.a).toBe(0x42);
  });

  it('runs over a CALL until SP returns (RET)', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // 0000: CALL 0010
    // 0003: NOP
    // 0010: LD A, 0x99 ; RET
    s.mem.set([0xCD, 0x10, 0x00, 0x00], 0);
    s.mem.set([0x3E, 0x99, 0xC9], 0x10);
    s.cpu.sp = 0xFF00;
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(0x0003); // returned past the CALL
    expect(s.cpu.a).toBe(0x99);    // subroutine actually ran
    expect(s.cpu.sp).toBe(0xFF00); // SP balanced
  });

  it('runs over an RST until SP returns', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // 0000: RST 8 (RST 0x08)
    // 0001: NOP
    // 0008: LD A, 0x77 ; RET
    s.mem[0] = 0xCF;        // RST 0x08
    s.mem[1] = 0x00;
    s.mem.set([0x3E, 0x77, 0xC9], 0x08);
    s.cpu.sp = 0xFF00;
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(0x0001);
    expect(s.cpu.a).toBe(0x77);
  });

  it('runs over a conditional CALL that is TAKEN', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // CALL NZ, 0010 with Z flag clear → taken.
    // 0000: CALL NZ, 0010 (C4 10 00)
    // 0003: NOP
    // 0010: LD A, 0x55 ; RET
    s.mem.set([0xC4, 0x10, 0x00, 0x00], 0);
    s.mem.set([0x3E, 0x55, 0xC9], 0x10);
    s.cpu.sp = 0xFF00;
    s.cpu.f = 0; // Z=0 → NZ taken
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(0x0003);
    expect(s.cpu.a).toBe(0x55);
  });

  it('a NOT-TAKEN conditional CALL falls through in one step', () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.mem.set([0xC4, 0x10, 0x00, 0x00], 0); // CALL NZ, 0010
    s.cpu.sp = 0xFF00;
    s.cpu.f = Z80.FLAG_Z; // Z=1 → NZ not taken
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(0x0003);
    expect(s.cpu.sp).toBe(0xFF00); // SP never moved
  });

  it('a taken JR cc that eventually returns to the next-sequential PC lands there', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // 0000: JR Z, +2  (28 02) → if taken, lands at 0004
    // 0002: NOP                  ← nextSequentialPC (target for step-over)
    // 0003: NOP
    // 0004: JR -4   (18 FC) → back to 0002
    s.mem.set([0x28, 0x02, 0x00, 0x00, 0x18, 0xFC], 0);
    s.cpu.f = Z80.FLAG_Z; // Z=1 → taken
    s.cpu.pc = 0;
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(0x0002);
    expect(s.cpu.tStates).toBeLessThan(5_000_000); // didn't hit safety limit
  });

  it('SMELL: a taken JR cc that NEVER returns to next-sequential PC spins to the safety limit', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // JR Z, -3 → on taken, PC = -1 = 0xFFFF.  At 0xFFFF: NOP, then PC wraps
    // to 0, then JR Z again (Z still set), infinite loop. nextSeqPC = 0x0002
    // is never visited.
    // Fill memory with a backwards JR Z to keep the cycle tight.
    s.mem.fill(0x00);
    s.mem.set([0x28, 0xFD], 0); // JR Z, -3
    s.cpu.f = Z80.FLAG_Z;
    s.cpu.pc = 0;
    dm.stepOver(s, vi.fn());
    expect(s.cpu.tStates).toBeGreaterThanOrEqual(5_000_000);
    expect(s.cpu.pc).not.toBe(0x0002); // never reached nextSequentialPC
    // The 5M-tState fallback (~1.4s of CPU time) is the only thing that
    // stops a runaway step-over of a divergent conditional jump.
  });

  it('steps over a conditional JR (JR Z not taken) cleanly to next instr', () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.mem.set([0x28, 0x02, 0x00], 0);
    s.cpu.f = 0; // Z=0 → not taken
    s.cpu.pc = 0;
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(2);
  });

  it('JP cc,nn NOT taken: advances exactly 3 bytes in one step', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // JP NZ, 0x0100 with Z=1 → not taken → PC = 0x0003.
    s.mem.set([0xC2, 0x00, 0x01, 0x00], 0);
    s.cpu.f = Z80.FLAG_Z; // Z=1 → NZ not taken
    s.cpu.pc = 0;
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(3);
    expect(s.cpu.sp).toBe(0xFFFF); // SP never touched (reset default)
  });

  it('JP cc,nn TAKEN that loops back to nextSeqPC stops correctly', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // 0000: JP Z, 0x0004  (CA 04 00) → taken (Z=1), PC = 0x0004.  nextSeqPC = 0x0003.
    // 0003: NOP (the target for step-over)
    // 0004: JP NZ, 0x0003 (C2 03 00) → Z still set → not taken → PC = 0x0007... loop
    // Instead: a simpler loop that does reach nextSeqPC.
    // 0000: JP Z, 0x0003 (CA 03 00) → lands at 0x0003 which IS nextSeqPC. Exits immediately.
    s.mem.set([0xCA, 0x03, 0x00, 0x00], 0);
    s.cpu.f = Z80.FLAG_Z;
    s.cpu.pc = 0;
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(3);
    expect(s.cpu.tStates).toBeLessThan(5_000_000);
  });

  it('JP cc,nn TAKEN that NEVER returns to nextSeqPC spins to the safety limit', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // 0000: JP Z, 0x0100 (CA 00 01). nextSeqPC=0x0003. 0x0100 loops to 0x0100 forever.
    // Z=1 → taken. Fill 0x0100 with JR -2 (tight loop, never reaches 0x0003).
    s.mem.fill(0x00);
    s.mem.set([0xCA, 0x00, 0x01], 0);
    s.mem.set([0x18, 0xFE], 0x0100);
    s.cpu.f = Z80.FLAG_Z;
    s.cpu.pc = 0;
    dm.stepOver(s, vi.fn());
    expect(s.cpu.tStates).toBeGreaterThanOrEqual(5_000_000);
    expect(s.cpu.pc).not.toBe(3);
  });

  it('stepOver CALL with SP=0 wraps correctly — subroutine runs to completion', () => {
    // targetSP = 0. CALL pushes 2 bytes → SP becomes 0xFFFE. Circular comparison
    // ((0 - 0xFFFE) & 0xFFFF = 0x0002) > 0 correctly keeps the loop running
    // until RET restores SP to 0x0000.
    const dm = new DebugManager();
    const s = makeStub();
    s.mem.set([0xCD, 0x10, 0x00], 0);       // CALL 0x0010
    s.mem.set([0x3E, 0x42, 0xC9], 0x10);    // LD A,0x42 ; RET
    s.cpu.sp = 0x0000;
    s.cpu.pc = 0;
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(0x0003); // past the CALL
    expect(s.cpu.a).toBe(0x42);    // subroutine ran
    expect(s.cpu.sp).toBe(0x0000); // SP balanced
  });

  it('steps over DJNZ (taken) — loops until B=0 and falls through', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // 0000: DJNZ -2 (loops to 0000)
    // 0002: NOP
    s.mem.set([0x10, 0xFE, 0x00], 0);
    s.cpu.b = 3;
    s.cpu.pc = 0;
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(2);
    expect(s.cpu.b).toBe(0);
  });

  it('runs LDIR to completion (BC reaches 0, PC moves to the next instruction)', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // 0000: LDIR (ED B0) ; 0002: NOP
    // Source @ 0x0010, dest @ 0x0020, count = 4.
    s.mem.set([0xED, 0xB0, 0x00], 0);
    s.mem.set([0xA1, 0xA2, 0xA3, 0xA4], 0x10);
    s.cpu.hl = 0x0010;
    s.cpu.de = 0x0020;
    s.cpu.bc = 4;
    s.cpu.pc = 0;

    dm.stepOver(s, vi.fn());

    expect(s.cpu.pc).toBe(0x0002);
    expect(s.cpu.bc).toBe(0);
    expect(Array.from(s.mem.slice(0x20, 0x24))).toEqual([0xA1, 0xA2, 0xA3, 0xA4]);
  });

  it('runs LDDR (descending block copy) to completion', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // ED B8 = LDDR (decrement HL/DE, copy until BC=0).
    s.mem.set([0xED, 0xB8, 0x00], 0);
    s.mem.set([0xA1, 0xA2, 0xA3], 0x10);
    // HL/DE point to last byte; BC = 3.
    s.cpu.hl = 0x0012;
    s.cpu.de = 0x0022;
    s.cpu.bc = 3;
    s.cpu.pc = 0;
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(0x0002);
    expect(s.cpu.bc).toBe(0);
    expect(Array.from(s.mem.slice(0x20, 0x23))).toEqual([0xA1, 0xA2, 0xA3]);
  });

  it.each([
    [0xB0, 'LDIR'],
    [0xB1, 'CPIR'],
    [0xB2, 'INIR'],
    [0xB3, 'OTIR'],
    [0xB8, 'LDDR'],
    [0xB9, 'CPDR'],
    [0xBA, 'INDR'],
    [0xBB, 'OTDR'],
  ])('recognises ED %s (%s) as a block repeat and uses PC-based completion', (subOp) => {
    // Verify the detection mask alone — we don't need to fully execute every
    // block repeat. Set BC=1 so the instruction terminates in one iteration,
    // and check that PC advanced past the block-repeat opcode (PC=2) rather
    // than rewinding (which would indicate detection failed).
    const dm = new DebugManager();
    const s = makeStub();
    s.mem.set([0xED, subOp, 0x00], 0);
    s.cpu.pc = 0;
    s.cpu.bc = 1;
    // Wire up enough port I/O that I/O block ops don't error.
    s.cpu.portInHandler = () => 0;
    s.cpu.portOutHandler = () => {};
    dm.stepOver(s, vi.fn());
    expect(s.cpu.pc).toBe(0x0002);
  });
});

// ── stepOut ──────────────────────────────────────────────────────────────

describe('DebugManager.stepOut', () => {
  it('runs until SP returns to (initial + 2) — i.e. until the next RET', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // Simulate being mid-subroutine: SP has a return address on top.
    // 0010: LD A, 0xAB ; RET
    s.mem.set([0x3E, 0xAB, 0xC9], 0x10);
    s.cpu.sp = 0xFEFE;
    // Push a fake return address (0x0030) so RET pops to 0x0030.
    s.mem[0xFEFE] = 0x30; s.mem[0xFEFF] = 0x00;
    // Set NOPs at the return site so the post-RET execution is a no-op.
    s.mem[0x0030] = 0x00;
    s.cpu.pc = 0x0010;

    dm.stepOut(s, vi.fn());

    expect(s.cpu.pc).toBe(0x0030); // returned to caller
    expect(s.cpu.sp).toBe(0xFF00); // SP popped 2 bytes
    expect(s.cpu.a).toBe(0xAB);    // subroutine actually ran
  });

  it('bails out at the safety tState limit if RET never happens', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // Infinite loop: JR -2 at 0x0000.
    s.mem.set([0x18, 0xFE], 0);
    s.cpu.sp = 0xFEFE;
    s.cpu.pc = 0;
    dm.stepOut(s, vi.fn());
    expect(s.cpu.tStates).toBeGreaterThanOrEqual(10_000_000);
    // PC still in the loop; SP never moved.
    expect(s.cpu.sp).toBe(0xFEFE);
  });

  it('works with RETI (ED 4D) — same SP-based detection as RET', () => {
    const dm = new DebugManager();
    const s = makeStub();
    // 0x0010: RETI (ED 4D), returns to the address on the stack.
    s.mem.set([0xED, 0x4D], 0x10);
    s.cpu.sp = 0xFEFE;
    s.mem[0xFEFE] = 0x30; s.mem[0xFEFF] = 0x00; // return to 0x0030
    s.mem[0x0030] = 0x00; // NOP at return site
    s.cpu.pc = 0x0010;
    dm.stepOut(s, vi.fn());
    expect(s.cpu.pc).toBe(0x0030);
    expect(s.cpu.sp).toBe(0xFF00); // 0xFEFE + 2
  });

  it('stepOut with SP=0xFFFE wraps correctly — stops after RET', () => {
    // targetSP = (0xFFFE + 2) & 0xFFFF = 0x0000. Circular comparison
    // ((0 - 0xFFFE) & 0xFFFF = 0x0002) > 0 keeps the loop running; after RET
    // SP becomes 0x0000 and ((0 - 0) & 0xFFFF = 0) exits immediately.
    const dm = new DebugManager();
    const s = makeStub();
    s.mem.set([0x3E, 0xAB, 0xC9], 0x10); // LD A,0xAB ; RET
    s.cpu.sp = 0xFFFE;
    s.mem[0xFFFE] = 0x30; s.mem[0xFFFF] = 0x00; // return to 0x0030
    s.mem[0x0030] = 0x00; // NOP at return site
    s.cpu.pc = 0x0010;
    dm.stepOut(s, vi.fn());
    expect(s.cpu.a).toBe(0xAB);    // subroutine ran
    expect(s.cpu.sp).toBe(0x0000); // SP popped from 0xFFFE to 0x0000
    expect(s.cpu.pc).toBe(0x0030); // returned to caller
    expect(s.cpu.tStates).toBeLessThan(10_000_000); // no longer spins to limit
  });
});

// ── stepFrame ────────────────────────────────────────────────────────────

describe('DebugManager.stepFrame', () => {
  it('calls tick and onUpdate; skips display update when display is null', () => {
    const dm = new DebugManager();
    const s = makeStub();
    const onUpdate = vi.fn();
    expect(() => dm.stepFrame(s, onUpdate)).not.toThrow();
    expect(s.tick).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('updates the display texture when a display is attached', () => {
    const dm = new DebugManager();
    const s = makeStub();
    const updateTexture = vi.fn();
    (s as any).display = { updateTexture };
    dm.stepFrame(s, vi.fn());
    expect(updateTexture).toHaveBeenCalledOnce();
    expect(updateTexture).toHaveBeenCalledWith((s as any).pixels);
  });
});

// ── Breakpoints ──────────────────────────────────────────────────────────

describe('DebugManager.toggleBreakpoint', () => {
  it('adds a breakpoint that did not exist and reports it', () => {
    const dm = new DebugManager();
    const s = makeStub();
    const status = vi.fn(); const update = vi.fn();
    dm.toggleBreakpoint(s, 0x8000, status, update);
    expect(s.breakpoints.has(0x8000)).toBe(true);
    expect(status).toHaveBeenCalledWith(expect.stringMatching(/set.*8000/i));
    expect(update).toHaveBeenCalledOnce();
  });

  it('removes a breakpoint that already existed', () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.breakpoints.add(0x8000);
    const status = vi.fn();
    dm.toggleBreakpoint(s, 0x8000, status, vi.fn());
    expect(s.breakpoints.has(0x8000)).toBe(false);
    expect(status).toHaveBeenCalledWith(expect.stringMatching(/removed.*8000/i));
  });
});

// ── runTo ────────────────────────────────────────────────────────────────

describe('DebugManager.runTo', () => {
  it('sets a fresh breakpoint, records pendingRunTo, and resumes if paused', () => {
    const dm = new DebugManager();
    const s = makeStub();
    const onResume = vi.fn();
    dm.runTo(s, 0x4000, /* paused */ true, onResume);
    expect(s.breakpoints.has(0x4000)).toBe(true);
    expect(dm.getPendingRunTo()).toBe(0x4000);
    expect(s.start).toHaveBeenCalledOnce();
    expect(onResume).toHaveBeenCalledOnce();
  });

  it('does NOT record pendingRunTo when the breakpoint was already user-set', () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.breakpoints.add(0x4000);
    dm.runTo(s, 0x4000, /* paused */ true, vi.fn());
    expect(dm.getPendingRunTo()).toBe(-1); // sentinel for "no pending"
    // The user's breakpoint must remain after the BP hits.
    expect(s.breakpoints.has(0x4000)).toBe(true);
  });

  it('does NOT start emulation if it is already running', () => {
    const dm = new DebugManager();
    const s = makeStub();
    dm.runTo(s, 0x4000, /* paused */ false, vi.fn());
    expect(s.start).not.toHaveBeenCalled();
  });

  it('still sets the breakpoint and pendingRunTo even when not paused', () => {
    const dm = new DebugManager();
    const s = makeStub();
    dm.runTo(s, 0x5000, /* paused */ false, vi.fn());
    expect(s.breakpoints.has(0x5000)).toBe(true);
    expect(dm.getPendingRunTo()).toBe(0x5000);
  });

  it('clearPendingRunTo resets the sentinel', () => {
    const dm = new DebugManager();
    const s = makeStub();
    dm.runTo(s, 0x4000, true, vi.fn());
    dm.clearPendingRunTo();
    expect(dm.getPendingRunTo()).toBe(-1);
  });
});

// ── Tracing ──────────────────────────────────────────────────────────────

describe('DebugManager.startTrace / stopTrace', () => {
  it('forwards the trace mode and fires onStart', () => {
    const dm = new DebugManager();
    const s = makeStub();
    const onStart = vi.fn();
    dm.startTrace(s, 'portio', onStart);
    expect(s.startTrace).toHaveBeenCalledWith('portio');
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('defaults to "full" mode when omitted', () => {
    const dm = new DebugManager();
    const s = makeStub();
    dm.startTrace(s, undefined as any, vi.fn());
    expect(s.startTrace).toHaveBeenCalledWith('full');
  });

  it('forwards the "zxtl" trace mode', () => {
    const dm = new DebugManager();
    const s = makeStub();
    dm.startTrace(s, 'zxtl', vi.fn());
    expect(s.startTrace).toHaveBeenCalledWith('zxtl');
  });

  it('reports trace text and line count', () => {
    const dm = new DebugManager();
    const s = makeStub();
    vi.mocked(s.stopTrace).mockReturnValueOnce('one\ntwo\nthree');
    const onStop = vi.fn();
    dm.stopTrace(s, onStop);
    expect(onStop).toHaveBeenCalledWith('one\ntwo\nthree', 3);
  });

  it('reports 0 lines for an empty trace (no split-on-newline off-by-one)', () => {
    const dm = new DebugManager();
    const s = makeStub();
    vi.mocked(s.stopTrace).mockReturnValueOnce('');
    const onStop = vi.fn();
    dm.stopTrace(s, onStop);
    expect(onStop).toHaveBeenCalledWith('', 0);
  });

  it('counts a single unterminated line as 1', () => {
    const dm = new DebugManager();
    const s = makeStub();
    vi.mocked(s.stopTrace).mockReturnValueOnce('only-one');
    const onStop = vi.fn();
    dm.stopTrace(s, onStop);
    expect(onStop).toHaveBeenCalledWith('only-one', 1);
  });
});

// ── copyCpuState ─────────────────────────────────────────────────────────

describe('DebugManager.copyCpuState', () => {
  let written: string | null;

  beforeEach(() => {
    written = null;
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: (t: string) => { written = t; return Promise.resolve(); } } },
      writable: true, configurable: true,
    });
  });

  it('writes registers, flags and disassembly to the clipboard', async () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.cpu.pc = 0x1234;
    s.cpu.sp = 0xFF00;
    s.cpu.a = 0x12; s.cpu.f = Z80.FLAG_Z | Z80.FLAG_C;
    // Put a recognisable instruction at PC so the disassembly line is stable.
    s.mem[0x1234] = 0x00; // NOP
    const status = vi.fn();
    await dm.copyCpuState(s, status);

    expect(written).not.toBeNull();
    expect(written!).toContain('AF  12');
    expect(written!).toContain('PC  1234');
    expect(written!).toContain('SP  FF00');
    expect(written!).toContain('Zero=1');
    expect(written!).toContain('Carry=1');
    expect(written!).toContain('Sign=0');
    expect(written!).toContain('Disassembly');
    expect(written!).toMatch(/>\s+1234/); // PC marker on the current line
    expect(status).toHaveBeenCalledWith(expect.stringMatching(/copied/i));
  });

  it('disassembles 16 instructions starting at PC', async () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.cpu.pc = 0;
    // 16 NOPs at the start.
    for (let i = 0; i < 16; i++) s.mem[i] = 0x00;
    await dm.copyCpuState(s, vi.fn());
    // Should contain addresses 0000 through 000F inclusive.
    expect(written!).toContain(' 0000  ');
    expect(written!).toContain(' 000F  ');
  });

  it('includes shadow registers (AF\' BC\' DE\' HL\') in the output', async () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.cpu.a_ = 0xDE; s.cpu.f_ = 0xAD;
    s.cpu.b_ = 0x11; s.cpu.c_ = 0x22;
    s.cpu.d_ = 0x33; s.cpu.e_ = 0x44;
    s.cpu.h_ = 0x55; s.cpu.l_ = 0x66;
    await dm.copyCpuState(s, vi.fn());
    expect(written!).toContain("AF' DEAD");
    expect(written!).toContain("BC' 1122");
    expect(written!).toContain("DE' 3344");
    expect(written!).toContain("HL' 5566");
  });

  it('shows IX and IY registers', async () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.cpu.ix = 0xABCD;
    s.cpu.iy = 0x1234;
    await dm.copyCpuState(s, vi.fn());
    expect(written!).toContain('IX  ABCD');
    expect(written!).toContain('IY  1234');
  });

  it('shows EI when interrupts are enabled and DI when disabled', async () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.cpu.iff1 = true;
    await dm.copyCpuState(s, vi.fn());
    expect(written!).toContain('EI');

    written = null;
    s.cpu.iff1 = false;
    await dm.copyCpuState(s, vi.fn());
    expect(written!).toContain('DI');
    expect(written!).not.toContain('EI');
  });

  it('shows HALT when the CPU is halted', async () => {
    const dm = new DebugManager();
    const s = makeStub();
    s.cpu.halted = true;
    await dm.copyCpuState(s, vi.fn());
    expect(written!).toContain('HALT');

    written = null;
    s.cpu.halted = false;
    await dm.copyCpuState(s, vi.fn());
    expect(written!).not.toContain('HALT');
  });

  it('wraps disassembly around 0xFFFF without crashing', async () => {
    const dm = new DebugManager();
    const s = makeStub();
    // Place NOPs near the top of the address space; disassembly should wrap.
    s.cpu.pc = 0xFFF8;
    for (let i = 0; i < 16; i++) s.mem[(0xFFF8 + i) & 0xFFFF] = 0x00;
    await dm.copyCpuState(s, vi.fn());
    // The 16-instruction window crosses 0xFFFF; make sure we see addresses on both sides.
    expect(written!).toContain(' FFF8  ');
    expect(written!).toContain(' 0000  '); // wrapped around
  });

  it('reports clipboard failures via onStatus instead of silently swallowing', async () => {
    const dm = new DebugManager();
    const s = makeStub();
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: { writeText: () => Promise.reject(new Error('denied')) },
      },
      writable: true, configurable: true,
    });
    const status = vi.fn();
    await dm.copyCpuState(s, status);
    expect(status).toHaveBeenCalledWith(expect.stringMatching(/failed.*denied/i));
    expect(status).not.toHaveBeenCalledWith(expect.stringMatching(/^CPU state.*copied/i));
  });
});
