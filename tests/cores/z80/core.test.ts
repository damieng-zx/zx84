/**
 * Z80 core state tests — reset, register packing, EX/EXX, HALT,
 * R-register, DAA, CPL, SCF/CCF + Q register.
 */
import { describe, it, expect } from 'vitest';
import { newCpu, load, step, F_S, F_Z, F_F5, F_H, F_F3, F_PV, F_N, F_C } from './_harness.ts';

describe('Z80 — reset state', () => {
  it('zeros main and shadow registers, SP=0xFFFF, IM=0, halted=false', () => {
    const { cpu } = newCpu();
    cpu.a = 0xAA; cpu.f = 0x55; cpu.bc = 0x1234;
    cpu.sp = 0x1234;
    cpu.iff1 = true; cpu.halted = true; cpu.im = 2;
    cpu.reset();
    expect(cpu.a).toBe(0); expect(cpu.f).toBe(0);
    expect(cpu.bc).toBe(0); expect(cpu.de).toBe(0); expect(cpu.hl).toBe(0);
    expect(cpu.ix).toBe(0); expect(cpu.iy).toBe(0);
    // SP resets to 0xFFFF (power-on convention), not 0.
    expect(cpu.pc).toBe(0); expect(cpu.sp).toBe(0xFFFF);
    expect(cpu.i).toBe(0); expect(cpu.r).toBe(0);
    // Real hardware resets to IM 0 (Zilog datasheet); RESET does not select
    // IM 1 as a convenience default. ROMs that need IM 1 (e.g. the Spectrum
    // 48K ROM) select it explicitly during boot.
    expect(cpu.im).toBe(0);
    expect(cpu.iff1).toBe(false); expect(cpu.iff2).toBe(false);
    expect(cpu.halted).toBe(false);
  });
});

describe('Z80 — register pair packing', () => {
  it('hl/bc/de/af getter/setter pack big-endian', () => {
    const { cpu } = newCpu();
    cpu.hl = 0x1234;
    expect(cpu.h).toBe(0x12);
    expect(cpu.l).toBe(0x34);
    cpu.b = 0xAB; cpu.c = 0xCD;
    expect(cpu.bc).toBe(0xABCD);
  });
});

describe('Z80 — EX / EXX', () => {
  it("EX AF,AF' swaps A and F with the shadow set", () => {
    const h = newCpu();
    h.cpu.a = 0x11; h.cpu.f = 0x22;
    h.cpu.a_ = 0x33; h.cpu.f_ = 0x44;
    load(h.mem, 0, 0x08);
    step(h);
    expect(h.cpu.a).toBe(0x33); expect(h.cpu.f).toBe(0x44);
    expect(h.cpu.a_).toBe(0x11); expect(h.cpu.f_).toBe(0x22);
  });

  it('EXX swaps BC/DE/HL with shadows, leaves AF alone', () => {
    const h = newCpu();
    h.cpu.bc = 0x1111; h.cpu.de = 0x2222; h.cpu.hl = 0x3333;
    h.cpu.b_ = 0xAA; h.cpu.c_ = 0xBB;
    h.cpu.d_ = 0xCC; h.cpu.e_ = 0xDD;
    h.cpu.h_ = 0xEE; h.cpu.l_ = 0xFF;
    h.cpu.a = 0x99; h.cpu.f = 0x88;
    load(h.mem, 0, 0xD9);
    step(h);
    expect(h.cpu.bc).toBe(0xAABB);
    expect(h.cpu.de).toBe(0xCCDD);
    expect(h.cpu.hl).toBe(0xEEFF);
    expect(h.cpu.a).toBe(0x99); expect(h.cpu.f).toBe(0x88);
  });

  it('EX DE,HL swaps DE and HL', () => {
    const h = newCpu();
    h.cpu.de = 0x1234; h.cpu.hl = 0x5678;
    load(h.mem, 0, 0xEB);
    step(h);
    expect(h.cpu.de).toBe(0x5678);
    expect(h.cpu.hl).toBe(0x1234);
  });

  it('EX (SP),HL swaps top of stack with HL', () => {
    const h = newCpu();
    h.cpu.sp = 0xC000;
    h.mem[0xC000] = 0x34; h.mem[0xC001] = 0x12;
    h.cpu.hl = 0xABCD;
    load(h.mem, 0, 0xE3);
    step(h);
    expect(h.cpu.hl).toBe(0x1234);
    expect(h.mem[0xC000]).toBe(0xCD);
    expect(h.mem[0xC001]).toBe(0xAB);
  });
});

describe('Z80 — HALT', () => {
  it('HALT sets halted flag and stalls PC', () => {
    const h = newCpu();
    load(h.mem, 0, 0x76); // HALT
    step(h);
    expect(h.cpu.halted).toBe(true);
    const pcBefore = h.cpu.pc;
    step(h); // another step while halted — PC stays put
    expect(h.cpu.pc).toBe(pcBefore);
  });

  it('interrupt wakes HALT and advances PC past the HALT', () => {
    const h = newCpu();
    h.cpu.iff1 = true;
    h.cpu.sp = 0xC010;
    load(h.mem, 0, 0x76); // HALT
    step(h);
    expect(h.cpu.halted).toBe(true);
    h.cpu.interrupt();
    expect(h.cpu.halted).toBe(false);
    // The pushed return address must be the instruction *after* the HALT, so
    // RETI/RET returns to the next instruction — not to the HALT itself.
    expect(h.mem[0xC00E]).toBe(0x01);
    expect(h.mem[0xC00F]).toBe(0x00);
  });
});

describe('Z80 — DAA', () => {
  it('adjusts BCD addition: 0x09 + 0x01 → 0x10 after DAA', () => {
    const h = newCpu();
    load(h.mem, 0,
      0x3E, 0x09,        // LD A,$09
      0xC6, 0x01,        // ADD A,$01 → $0A, H=1
      0x27,              // DAA → $10
    );
    step(h, 3);
    expect(h.cpu.a).toBe(0x10);
  });

  it('adjusts BCD subtraction: 0x10 - 0x01 → 0x09 after DAA', () => {
    const h = newCpu();
    load(h.mem, 0,
      0x3E, 0x10,        // LD A,$10
      0xD6, 0x01,        // SUB $01 → $0F, H=1, N=1
      0x27,              // DAA → $09
    );
    step(h, 3);
    expect(h.cpu.a).toBe(0x09);
  });
});

describe('Z80 — CPL', () => {
  it('inverts all bits of A', () => {
    const h = newCpu();
    h.cpu.a = 0xA5;
    load(h.mem, 0, 0x2F); // CPL
    step(h);
    expect(h.cpu.a).toBe(0x5A);
  });

  it('always sets H=1 and N=1', () => {
    const h = newCpu();
    h.cpu.a = 0x00;
    h.cpu.f = 0x00;
    load(h.mem, 0, 0x2F);
    step(h);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('preserves S, Z, PV, C', () => {
    const h = newCpu();
    h.cpu.a = 0x00;
    h.cpu.f = F_S | F_Z | F_PV | F_C;
    load(h.mem, 0, 0x2F);
    step(h);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('F3/F5 come from result bits 3 and 5', () => {
    const h = newCpu();
    h.cpu.a = 0xD7; // 11010111 → CPL → 00101000 = 0x28
    load(h.mem, 0, 0x2F);
    step(h);
    expect(h.cpu.a).toBe(0x28);
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
  });
});

describe('Z80 — SCF/CCF and the Q register', () => {
  it('SCF sets C, clears H and N', () => {
    const h = newCpu();
    h.cpu.f = F_H | F_N;
    load(h.mem, 0, 0x37);
    step(h);
    expect(h.cpu.f & F_C).toBe(F_C);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('CCF inverts C; H gets the old C', () => {
    const h = newCpu();
    h.cpu.f = F_C;
    load(h.mem, 0, 0x3F);
    step(h);
    expect(h.cpu.f & F_C).toBe(0);
    expect(h.cpu.f & F_H).toBe(F_H);
  });

  it('SCF after a non-flag instruction: F3/F5 = A bits 3/5 (Q=0 case)', () => {
    // Sequence: LD A,$FF (does NOT modify F) ; SCF
    // After SCF, F3/F5 should come from A (0xFF → both set).
    const h = newCpu();
    load(h.mem, 0, 0x3E, 0xFF, 0x37); // LD A,$FF ; SCF
    step(h, 2);
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
  });
});

describe('Z80 — R register increment', () => {
  it('only the low 7 bits increment; bit 7 is preserved', () => {
    const h = newCpu();
    h.cpu.r = 0xFF; // 0x7F + bit 7
    load(h.mem, 0, 0x00, 0x00); // NOP NOP
    step(h);
    // 0x7F + 1 wraps to 0x00 in low 7 bits, bit 7 preserved
    expect(h.cpu.r).toBe(0x80);
    step(h);
    expect(h.cpu.r).toBe(0x81);
  });

  it('LD A,R reads the live R, LD R,A writes all 8 bits', () => {
    const h = newCpu();
    h.cpu.a = 0x42;
    load(h.mem, 0,
      0xED, 0x4F,   // LD R,A
      0xED, 0x5F,   // LD A,R
    );
    step(h); // LD R,A — both M1s increment R first, *then* A is written to R
    expect(h.cpu.r & 0x7F).toBe(0x42 & 0x7F);
    step(h); // LD A,R — its own two M1 cycles increment R twice before A := R
    // Documented: A receives R *after* both M1 increments of this very op.
    expect(h.cpu.a & 0x7F).toBe((0x42 + 2) & 0x7F);
  });
});
