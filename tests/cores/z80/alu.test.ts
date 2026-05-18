/**
 * Z80 ALU tests — 8-bit ADD/ADC/SUB/SBC/AND/OR/XOR/CP, INC/DEC,
 * 16-bit ADD/ADC/SBC HL, and NEG.
 */
import { describe, it, expect } from 'vitest';
import { newCpu, load, step, F_S, F_Z, F_F5, F_H, F_F3, F_PV, F_N, F_C } from './_harness.ts';

describe('Z80 — ADD A,n flag semantics', () => {
  function add(a: number, n: number): { res: number; f: number } {
    const h = newCpu();
    h.cpu.a = a;
    load(h.mem, 0, 0xC6, n); // ADD A,n
    step(h);
    return { res: h.cpu.a, f: h.cpu.f };
  }

  it('0x10 + 0x20 → no carry, no half-carry, no zero, no sign', () => {
    const { res, f } = add(0x10, 0x20);
    expect(res).toBe(0x30);
    expect(f & F_C).toBe(0);
    expect(f & F_H).toBe(0);
    expect(f & F_Z).toBe(0);
    expect(f & F_S).toBe(0);
    expect(f & F_N).toBe(0);
  });

  it('0x0F + 0x01 → half-carry set', () => {
    const { res, f } = add(0x0F, 0x01);
    expect(res).toBe(0x10);
    expect(f & F_H).toBe(F_H);
  });

  it('0xFF + 0x01 → 0, carry, half-carry, zero', () => {
    const { res, f } = add(0xFF, 0x01);
    expect(res).toBe(0);
    expect(f & F_C).toBe(F_C);
    expect(f & F_H).toBe(F_H);
    expect(f & F_Z).toBe(F_Z);
  });

  it('0x7F + 0x01 → 0x80: sign set, overflow set', () => {
    const { res, f } = add(0x7F, 0x01);
    expect(res).toBe(0x80);
    expect(f & F_S).toBe(F_S);
    expect(f & F_PV).toBe(F_PV); // signed overflow: positive + positive = negative
    expect(f & F_C).toBe(0);
  });

  it('0x80 + 0x80 → 0: overflow set, carry set', () => {
    const { res, f } = add(0x80, 0x80);
    expect(res).toBe(0);
    expect(f & F_PV).toBe(F_PV);
    expect(f & F_C).toBe(F_C);
    expect(f & F_Z).toBe(F_Z);
  });

  it('undocumented F3/F5 copy from result bits 3/5', () => {
    const { f } = add(0x20, 0x08); // result 0x28 → bits 3,5 set
    expect(f & F_F3).toBe(F_F3);
    expect(f & F_F5).toBe(F_F5);
  });
});

describe('Z80 — ADC A,n flag semantics', () => {
  function adc(a: number, n: number, carry: number): { res: number; f: number } {
    const h = newCpu();
    h.cpu.a = a;
    h.cpu.f = carry ? F_C : 0;
    load(h.mem, 0, 0xCE, n); // ADC A,n
    step(h);
    return { res: h.cpu.a, f: h.cpu.f };
  }

  it('0x10 + 0x20 + C=0 behaves like ADD', () => {
    const { res } = adc(0x10, 0x20, 0);
    expect(res).toBe(0x30);
  });

  it('0x10 + 0x20 + C=1 = 0x31', () => {
    const { res, f } = adc(0x10, 0x20, 1);
    expect(res).toBe(0x31);
    expect(f & F_C).toBe(0);
    expect(f & F_N).toBe(0);
  });

  it('0xFF + 0x00 + C=1 → 0, carry out, zero', () => {
    const { res, f } = adc(0xFF, 0x00, 1);
    expect(res).toBe(0);
    expect(f & F_C).toBe(F_C);
    expect(f & F_Z).toBe(F_Z);
  });

  it('0x7F + 0x00 + C=1 → 0x80: signed overflow, S set', () => {
    const { res, f } = adc(0x7F, 0x00, 1);
    expect(res).toBe(0x80);
    expect(f & F_PV).toBe(F_PV);
    expect(f & F_S).toBe(F_S);
    expect(f & F_C).toBe(0);
  });
});

describe('Z80 — SUB A,n flag semantics', () => {
  function sub(a: number, n: number): { res: number; f: number } {
    const h = newCpu();
    h.cpu.a = a;
    load(h.mem, 0, 0xD6, n);
    step(h);
    return { res: h.cpu.a, f: h.cpu.f };
  }

  it('always sets N flag', () => {
    const { f } = sub(0x10, 0x05);
    expect(f & F_N).toBe(F_N);
  });

  it('0x10 - 0x10 → zero', () => {
    const { res, f } = sub(0x10, 0x10);
    expect(res).toBe(0);
    expect(f & F_Z).toBe(F_Z);
  });

  it('0x00 - 0x01 → 0xFF, borrow (C), half-borrow (H), sign', () => {
    const { res, f } = sub(0x00, 0x01);
    expect(res).toBe(0xFF);
    expect(f & F_C).toBe(F_C);
    expect(f & F_H).toBe(F_H);
    expect(f & F_S).toBe(F_S);
  });

  it('0x80 - 0x01 → 0x7F: signed overflow (negative - positive = positive)', () => {
    const { res, f } = sub(0x80, 0x01);
    expect(res).toBe(0x7F);
    expect(f & F_PV).toBe(F_PV);
  });
});

describe('Z80 — SBC A,n flag semantics', () => {
  function sbc(a: number, n: number, carry: number): { res: number; f: number } {
    const h = newCpu();
    h.cpu.a = a;
    h.cpu.f = carry ? F_C : 0;
    load(h.mem, 0, 0xDE, n); // SBC A,n
    step(h);
    return { res: h.cpu.a, f: h.cpu.f };
  }

  it('always sets N flag', () => {
    const { f } = sbc(0x10, 0x05, 0);
    expect(f & F_N).toBe(F_N);
  });

  it('0x10 - 0x10 - C=0 → 0, Z set', () => {
    const { res, f } = sbc(0x10, 0x10, 0);
    expect(res).toBe(0);
    expect(f & F_Z).toBe(F_Z);
  });

  it('0x10 - 0x0F - C=1 → 0, Z set (borrow consumes the difference)', () => {
    const { res, f } = sbc(0x10, 0x0F, 1);
    expect(res).toBe(0);
    expect(f & F_Z).toBe(F_Z);
  });

  it('0x00 - 0x00 - C=1 → 0xFF, borrow, half-borrow, sign', () => {
    const { res, f } = sbc(0x00, 0x00, 1);
    expect(res).toBe(0xFF);
    expect(f & F_C).toBe(F_C);
    expect(f & F_S).toBe(F_S);
  });

  it('0x80 - 0x00 - C=1 → 0x7F: signed overflow', () => {
    const { res, f } = sbc(0x80, 0x00, 1);
    expect(res).toBe(0x7F);
    expect(f & F_PV).toBe(F_PV);
    expect(f & F_C).toBe(0);
  });
});

describe('Z80 — CP n is SUB without storing result', () => {
  it('CP equal → Z set, A unchanged', () => {
    const h = newCpu();
    h.cpu.a = 0x42;
    load(h.mem, 0, 0xFE, 0x42); // CP $42
    step(h);
    expect(h.cpu.a).toBe(0x42);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('CP: undocumented F3/F5 come from the *operand*, not the result', () => {
    const h = newCpu();
    h.cpu.a = 0x00;
    load(h.mem, 0, 0xFE, 0x28); // CP $28 (bits 3,5 set in operand)
    step(h);
    // Documented quirk: CP copies F3/F5 from the operand byte, unlike SUB
    // which copies them from the result.
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
  });
});

describe('Z80 — AND / OR / XOR flag semantics', () => {
  it('AND sets H, clears C and N, computes parity', () => {
    const h = newCpu();
    h.cpu.a = 0xFF;
    load(h.mem, 0, 0xE6, 0x0F); // AND $0F → 0x0F (4 bits set = even parity)
    step(h);
    expect(h.cpu.a).toBe(0x0F);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_C).toBe(0);
    expect(h.cpu.f & F_PV).toBe(F_PV); // parity even
  });

  it('OR clears C/N/H, computes parity', () => {
    const h = newCpu();
    h.cpu.a = 0x0F;
    load(h.mem, 0, 0xF6, 0xF0); // OR $F0 → 0xFF (8 bits = even parity)
    step(h);
    expect(h.cpu.a).toBe(0xFF);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_C).toBe(0);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('XOR A,A always zeroes A and sets Z, P', () => {
    const h = newCpu();
    h.cpu.a = 0x42;
    load(h.mem, 0, 0xAF); // XOR A
    step(h);
    expect(h.cpu.a).toBe(0);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_C).toBe(0);
  });
});

describe('Z80 — INC/DEC 8-bit flag semantics', () => {
  it('INC B preserves C, sets N=0', () => {
    const h = newCpu();
    h.cpu.b = 0x10; h.cpu.f = F_C;
    load(h.mem, 0, 0x04); // INC B
    step(h);
    expect(h.cpu.b).toBe(0x11);
    expect(h.cpu.f & F_C).toBe(F_C);
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('INC 0x7F → 0x80: PV set (signed overflow), S set, H set', () => {
    const h = newCpu();
    h.cpu.b = 0x7F;
    load(h.mem, 0, 0x04);
    step(h);
    expect(h.cpu.b).toBe(0x80);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_H).toBe(F_H);
  });

  it('DEC always sets N=1', () => {
    const h = newCpu();
    h.cpu.b = 0x01;
    load(h.mem, 0, 0x05); // DEC B
    step(h);
    expect(h.cpu.b).toBe(0);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('DEC 0x80 → 0x7F: PV set', () => {
    const h = newCpu();
    h.cpu.b = 0x80;
    load(h.mem, 0, 0x05);
    step(h);
    expect(h.cpu.b).toBe(0x7F);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('INC (HL): increments memory at HL, same flag semantics as INC r', () => {
    const h = newCpu();
    h.cpu.hl = 0x4000;
    h.mem[0x4000] = 0x7F;
    load(h.mem, 0, 0x34); // INC (HL)
    step(h);
    expect(h.mem[0x4000]).toBe(0x80);
    expect(h.cpu.f & F_PV).toBe(F_PV); // 0x7F→0x80: signed overflow
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('INC (HL): wrap 0xFF → 0x00, Z set, H set', () => {
    const h = newCpu();
    h.cpu.hl = 0x5000;
    h.mem[0x5000] = 0xFF;
    load(h.mem, 0, 0x34);
    step(h);
    expect(h.mem[0x5000]).toBe(0x00);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_H).toBe(F_H);
  });

  it('DEC (HL): decrements memory at HL, sets N', () => {
    const h = newCpu();
    h.cpu.hl = 0x4000;
    h.mem[0x4000] = 0x01;
    load(h.mem, 0, 0x35); // DEC (HL)
    step(h);
    expect(h.mem[0x4000]).toBe(0x00);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('DEC (HL): 0x80 → 0x7F: PV set (signed overflow)', () => {
    const h = newCpu();
    h.cpu.hl = 0x4000;
    h.mem[0x4000] = 0x80;
    load(h.mem, 0, 0x35);
    step(h);
    expect(h.mem[0x4000]).toBe(0x7F);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_N).toBe(F_N);
  });
});

describe('Z80 — INC/DEC 16-bit do not affect flags', () => {
  it('INC HL: F preserved', () => {
    const h = newCpu();
    h.cpu.hl = 0xFFFF; h.cpu.f = 0xFF;
    load(h.mem, 0, 0x23);
    step(h);
    expect(h.cpu.hl).toBe(0);
    expect(h.cpu.f).toBe(0xFF);
  });
});

describe('Z80 — ADD HL,rr', () => {
  it('preserves S/Z/PV; sets C and H from bit-12/bit-16 carries', () => {
    const h = newCpu();
    h.cpu.hl = 0x0FFF; h.cpu.bc = 0x0001; h.cpu.f = F_S | F_Z | F_PV;
    load(h.mem, 0, 0x09); // ADD HL,BC
    step(h);
    expect(h.cpu.hl).toBe(0x1000);
    expect(h.cpu.f & F_H).toBe(F_H);    // half-carry out of bit 11
    expect(h.cpu.f & F_C).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
    // S/Z/PV preserved
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('overflow into bit 16 sets C', () => {
    const h = newCpu();
    h.cpu.hl = 0xFFFF; h.cpu.bc = 0x0001;
    load(h.mem, 0, 0x09);
    step(h);
    expect(h.cpu.hl).toBe(0x0000);
    expect(h.cpu.f & F_C).toBe(F_C);
  });
});

describe('Z80 — ED SBC HL,rr', () => {
  it('SBC HL,DE with HL=0, DE=1, C=0 → 0xFFFF, S/H/C/N set', () => {
    const h = newCpu();
    h.cpu.hl = 0x0000; h.cpu.de = 0x0001; h.cpu.f = 0;
    load(h.mem, 0, 0xED, 0x52);
    step(h);
    expect(h.cpu.hl).toBe(0xFFFF);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_C).toBe(F_C);
    expect(h.cpu.f & F_N).toBe(F_N);
  });
});

describe('Z80 — ED ADC HL,rr', () => {
  it('ADC HL,BC adds HL, BC, and carry', () => {
    const h = newCpu();
    h.cpu.hl = 0x0001; h.cpu.bc = 0x0001; h.cpu.f = F_C;
    load(h.mem, 0, 0xED, 0x4A); // ADC HL,BC
    step(h);
    expect(h.cpu.hl).toBe(0x0003);
    expect(h.cpu.f & F_C).toBe(0);
    expect(h.cpu.f & F_N).toBe(0); // ADC clears N (unlike SBC)
  });

  it('carry out of bit 15 sets C', () => {
    const h = newCpu();
    h.cpu.hl = 0xFFFF; h.cpu.bc = 0x0000; h.cpu.f = F_C;
    load(h.mem, 0, 0xED, 0x4A);
    step(h);
    expect(h.cpu.hl).toBe(0x0000);
    expect(h.cpu.f & F_C).toBe(F_C);
    expect(h.cpu.f & F_Z).toBe(F_Z);
  });

  it('signed overflow sets V: 0x7FFF + 0 + C=1 → 0x8000', () => {
    const h = newCpu();
    h.cpu.hl = 0x7FFF; h.cpu.bc = 0x0000; h.cpu.f = F_C;
    load(h.mem, 0, 0xED, 0x4A);
    step(h);
    expect(h.cpu.hl).toBe(0x8000);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_C).toBe(0);
  });

  it('result zero with no carry sets Z', () => {
    const h = newCpu();
    h.cpu.hl = 0x0000; h.cpu.bc = 0x0000; h.cpu.f = 0;
    load(h.mem, 0, 0xED, 0x4A);
    step(h);
    expect(h.cpu.hl).toBe(0x0000);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_S).toBe(0);
  });
});

describe('Z80 — NEG', () => {
  it('NEG: A = 0 - A; sets N, sets C when A≠0', () => {
    const h = newCpu();
    h.cpu.a = 0x42;
    load(h.mem, 0, 0xED, 0x44); // NEG
    step(h);
    expect(h.cpu.a).toBe(0xBE); // -0x42 & 0xFF = 0xBE
    expect(h.cpu.f & F_N).toBe(F_N);
    expect(h.cpu.f & F_C).toBe(F_C); // borrow when A≠0
  });

  it('NEG 0 → 0: Z set, C clear', () => {
    const h = newCpu();
    h.cpu.a = 0x00;
    load(h.mem, 0, 0xED, 0x44);
    step(h);
    expect(h.cpu.a).toBe(0x00);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_C).toBe(0);
  });

  it('NEG 0x80 → 0x80: overflow (minimum signed is its own negation), C set', () => {
    const h = newCpu();
    h.cpu.a = 0x80;
    load(h.mem, 0, 0xED, 0x44);
    step(h);
    expect(h.cpu.a).toBe(0x80);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('NEG 0x01 → 0xFF: S set, H set, C set', () => {
    const h = newCpu();
    h.cpu.a = 0x01;
    load(h.mem, 0, 0xED, 0x44);
    step(h);
    expect(h.cpu.a).toBe(0xFF);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_C).toBe(F_C);
  });
});
