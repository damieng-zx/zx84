/**
 * Z80 rotate/shift tests — RLCA/RRCA/RLA/RRA, CB rotates/shifts,
 * CB BIT/SET/RES (register form), and CB ops on (HL).
 */
import { describe, it, expect } from 'vitest';
import { newCpu, load, step, F_S, F_Z, F_H, F_F3, F_F5, F_PV, F_N, F_C } from './_harness.ts';

describe('Z80 — CB rotates/shifts', () => {
  it('RLC B: bit 7 → C and bit 0', () => {
    const h = newCpu();
    h.cpu.b = 0x81;
    load(h.mem, 0, 0xCB, 0x00); // RLC B
    step(h);
    expect(h.cpu.b).toBe(0x03);
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('RR B: C → bit 7, bit 0 → C', () => {
    const h = newCpu();
    h.cpu.b = 0x01; h.cpu.f = F_C;
    load(h.mem, 0, 0xCB, 0x18); // RR B
    step(h);
    expect(h.cpu.b).toBe(0x80);
    expect(h.cpu.f & F_C).toBe(F_C);
    expect(h.cpu.f & F_S).toBe(F_S);
  });

  it('SLA B clears bit 0, SRL B clears bit 7', () => {
    const h = newCpu();
    h.cpu.b = 0xFF;
    load(h.mem, 0, 0xCB, 0x20, 0xCB, 0x38); // SLA B ; SRL B
    step(h); expect(h.cpu.b).toBe(0xFE); expect(h.cpu.f & F_C).toBe(F_C);
    step(h); expect(h.cpu.b).toBe(0x7F); expect(h.cpu.f & F_C).toBe(0);
  });

  it('SRA preserves sign bit (arithmetic shift right)', () => {
    const h = newCpu();
    h.cpu.b = 0x80;
    load(h.mem, 0, 0xCB, 0x28); // SRA B
    step(h);
    expect(h.cpu.b).toBe(0xC0);
  });

  it('SLL (undocumented) shifts bit 0 in as 1', () => {
    const h = newCpu();
    h.cpu.b = 0x40;
    load(h.mem, 0, 0xCB, 0x30); // SLL B
    step(h);
    expect(h.cpu.b).toBe(0x81);
  });
});

describe('Z80 — CB BIT/SET/RES', () => {
  it('BIT n,r: Z reflects bit, H always set, N=0, C preserved', () => {
    const h = newCpu();
    h.cpu.b = 0x10; h.cpu.f = F_C;
    load(h.mem, 0, 0xCB, 0x60); // BIT 4,B (set)
    step(h);
    expect(h.cpu.f & F_Z).toBe(0);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_C).toBe(F_C); // preserved
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('BIT n,r: Z set when bit clear, also sets PV (= Z)', () => {
    const h = newCpu();
    h.cpu.b = 0x00;
    load(h.mem, 0, 0xCB, 0x40); // BIT 0,B
    step(h);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('SET 7,B / RES 7,B', () => {
    const h = newCpu();
    h.cpu.b = 0x00;
    load(h.mem, 0, 0xCB, 0xF8, 0xCB, 0xB8); // SET 7,B ; RES 7,B
    step(h); expect(h.cpu.b).toBe(0x80);
    step(h); expect(h.cpu.b).toBe(0x00);
  });
});

describe('Z80 — RLCA / RRCA / RLA / RRA', () => {
  it('RLCA: rotates A left, bit 7 wraps to bit 0 and to C', () => {
    const h = newCpu();
    h.cpu.a = 0x85; // 10000101
    load(h.mem, 0, 0x07); // RLCA
    step(h);
    expect(h.cpu.a).toBe(0x0B); // 00001011: bit7=1 wrapped to bit0
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('RLCA: C clear when bit 7 was 0', () => {
    const h = newCpu();
    h.cpu.a = 0x42; // 01000010
    load(h.mem, 0, 0x07);
    step(h);
    expect(h.cpu.a).toBe(0x84);
    expect(h.cpu.f & F_C).toBe(0);
  });

  it('RLCA: clears H and N; preserves S, Z, PV from before', () => {
    const h = newCpu();
    h.cpu.a = 0x01;
    h.cpu.f = F_S | F_Z | F_PV | F_H | F_N; // all set before
    load(h.mem, 0, 0x07);
    step(h);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_S).toBe(F_S); // preserved
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('RLCA: F3/F5 come from result bits 3 and 5', () => {
    const h = newCpu();
    h.cpu.a = 0x14; // 00010100 → rotated → 00101000 = 0x28
    load(h.mem, 0, 0x07);
    step(h);
    expect(h.cpu.a).toBe(0x28);
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
  });

  it('RRCA: rotates A right, bit 0 wraps to bit 7 and to C', () => {
    const h = newCpu();
    h.cpu.a = 0x85; // 10000101
    load(h.mem, 0, 0x0F); // RRCA
    step(h);
    expect(h.cpu.a).toBe(0xC2); // 11000010: bit0=1 wrapped to bit7
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('RRCA: C clear when bit 0 was 0', () => {
    const h = newCpu();
    h.cpu.a = 0x84; // 10000100
    load(h.mem, 0, 0x0F);
    step(h);
    expect(h.cpu.a).toBe(0x42);
    expect(h.cpu.f & F_C).toBe(0);
  });

  it('RRCA: clears H and N', () => {
    const h = newCpu();
    h.cpu.a = 0x02;
    h.cpu.f = F_H | F_N;
    load(h.mem, 0, 0x0F);
    step(h);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('RLA: rotates A left through carry (old C into bit 0, bit 7 to new C)', () => {
    const h = newCpu();
    h.cpu.a = 0x85; // 10000101
    h.cpu.f = F_C;  // incoming carry = 1
    load(h.mem, 0, 0x17); // RLA
    step(h);
    // bit7 (1) → new C; bit0 ← old C (1); A = 00001011
    expect(h.cpu.a).toBe(0x0B);
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('RLA: incoming C=0 feeds into bit 0', () => {
    const h = newCpu();
    h.cpu.a = 0x80; // 10000000
    h.cpu.f = 0;    // carry clear
    load(h.mem, 0, 0x17);
    step(h);
    expect(h.cpu.a).toBe(0x00); // bit7 shifted out, bit0=0 from old C
    expect(h.cpu.f & F_C).toBe(F_C); // bit7 went to C
  });

  it('RLA: clears H and N; preserves S/Z/PV', () => {
    const h = newCpu();
    h.cpu.a = 0x01;
    h.cpu.f = F_S | F_Z | F_PV | F_H | F_N;
    load(h.mem, 0, 0x17);
    step(h);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('RRA: rotates A right through carry (old C into bit 7, bit 0 to new C)', () => {
    const h = newCpu();
    h.cpu.a = 0x85; // 10000101
    h.cpu.f = 0;    // incoming carry = 0
    load(h.mem, 0, 0x1F); // RRA
    step(h);
    // bit0 (1) → new C; bit7 ← old C (0); A = 01000010
    expect(h.cpu.a).toBe(0x42);
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('RRA: incoming C=1 feeds into bit 7', () => {
    const h = newCpu();
    h.cpu.a = 0x84; // 10000100
    h.cpu.f = F_C;  // carry set
    load(h.mem, 0, 0x1F);
    step(h);
    expect(h.cpu.a).toBe(0xC2); // bit7 ← 1 from old C; 11000010
    expect(h.cpu.f & F_C).toBe(0); // bit0 was 0
  });

  it('RRA: clears H and N', () => {
    const h = newCpu();
    h.cpu.a = 0x02;
    h.cpu.f = F_H | F_N;
    load(h.mem, 0, 0x1F);
    step(h);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
  });
});

describe('Z80 — CB BIT/SET/RES on (HL)', () => {
  it('SET 3,(HL): sets bit 3 in memory at HL, writes back', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x00;
    load(h.mem, 0, 0xCB, 0xDE); // SET 3,(HL): x=3, y=3, z=6
    step(h);
    expect(h.mem[0xC000]).toBe(0x08);
  });

  it('RES 3,(HL): clears bit 3 in memory at HL, writes back', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0xFF;
    load(h.mem, 0, 0xCB, 0x9E); // RES 3,(HL): x=2, y=3, z=6
    step(h);
    expect(h.mem[0xC000]).toBe(0xF7);
  });

  it('BIT 7,(HL): tests bit 7, sets Z when clear, H always set', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x0F; // bit 7 clear
    load(h.mem, 0, 0xCB, 0x7E); // BIT 7,(HL)
    step(h);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.mem[0xC000]).toBe(0x0F); // unchanged
  });

  it('BIT 3,(HL): Z clear when bit 3 is set', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0xFF; // all bits set
    load(h.mem, 0, 0xCB, 0x5E); // BIT 3,(HL)
    step(h);
    expect(h.cpu.f & F_Z).toBe(0);
  });

  it('RLC (HL): rotates memory byte left, C from bit 7, writes back', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x81; // 10000001
    load(h.mem, 0, 0xCB, 0x06); // RLC (HL)
    step(h);
    expect(h.mem[0xC000]).toBe(0x03); // 00000011: bit7 wrapped to bit0
    expect(h.cpu.f & F_C).toBe(F_C);
  });
});
