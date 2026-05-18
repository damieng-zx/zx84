/**
 * Z80 control flow tests — JP, JR, DJNZ, CALL, RET, RST, DI/EI,
 * RETN, IM 0 interrupt.
 */
import { describe, it, expect } from 'vitest';
import { newCpu, load, step, F_S, F_Z, F_PV } from './_harness.ts';

describe('Z80 — JP / JR / DJNZ', () => {
  it('JP nn sets PC absolutely', () => {
    const h = newCpu();
    load(h.mem, 0, 0xC3, 0x34, 0x12); // JP $1234
    step(h);
    expect(h.cpu.pc).toBe(0x1234);
  });

  it('JP cc taken: JP M,$1234 when S set jumps', () => {
    const h = newCpu();
    h.cpu.f = F_S;
    load(h.mem, 0, 0xFA, 0x34, 0x12); // JP M,$1234 (y=7: sign set)
    step(h);
    expect(h.cpu.pc).toBe(0x1234);
  });

  it('JP cc not-taken: JP M,$1234 when S clear falls through', () => {
    const h = newCpu();
    h.cpu.f = 0;
    load(h.mem, 0, 0xFA, 0x34, 0x12); // JP M,$1234
    step(h);
    expect(h.cpu.pc).toBe(3); // consumed the 3-byte opcode
  });

  it('JP PE taken: JP PE,$2000 when PV set jumps', () => {
    const h = newCpu();
    h.cpu.f = F_PV;
    load(h.mem, 0, 0xEA, 0x00, 0x20); // JP PE,$2000 (y=5: PV set)
    step(h);
    expect(h.cpu.pc).toBe(0x2000);
  });

  it('JR e: forward and backward relative', () => {
    const h = newCpu();
    load(h.mem, 0x100, 0x18, 0x05); // JR +5
    h.cpu.pc = 0x100;
    step(h);
    expect(h.cpu.pc).toBe(0x107); // PC was at 0x102 after fetch, +5
    load(h.mem, 0x200, 0x18, 0xFE); // JR -2 → loops on itself
    h.cpu.pc = 0x200;
    step(h);
    expect(h.cpu.pc).toBe(0x200);
  });

  it('JR NZ taken / not taken based on Z flag', () => {
    const h = newCpu();
    h.cpu.f = F_Z;
    load(h.mem, 0, 0x20, 0x05); // JR NZ,+5
    step(h);
    expect(h.cpu.pc).toBe(2); // Z set → not taken
    h.cpu.f = 0;
    h.cpu.pc = 0;
    step(h);
    expect(h.cpu.pc).toBe(7); // taken
  });

  it('DJNZ decrements B; takes branch when B≠0', () => {
    const h = newCpu();
    h.cpu.b = 3;
    load(h.mem, 0, 0x10, 0xFE); // DJNZ -2
    step(h); expect(h.cpu.b).toBe(2); expect(h.cpu.pc).toBe(0);
    step(h); expect(h.cpu.b).toBe(1); expect(h.cpu.pc).toBe(0);
    step(h); expect(h.cpu.b).toBe(0); expect(h.cpu.pc).toBe(2);
  });
});

describe('Z80 — CALL / RET', () => {
  it('CALL pushes return address, jumps; RET pops it back', () => {
    const h = newCpu();
    h.cpu.sp = 0xC010;
    load(h.mem, 0,
      0xCD, 0x00, 0x10,  // CALL $1000
    );
    load(h.mem, 0x1000, 0xC9); // RET
    step(h);
    expect(h.cpu.pc).toBe(0x1000);
    expect(h.cpu.sp).toBe(0xC00E);
    expect(h.mem[0xC00E]).toBe(0x03); // return = 0x0003
    expect(h.mem[0xC00F]).toBe(0x00);
    step(h);
    expect(h.cpu.pc).toBe(0x0003);
    expect(h.cpu.sp).toBe(0xC010);
  });

  it('CALL cc: not-taken consumes 3 bytes but no stack write', () => {
    const h = newCpu();
    h.cpu.sp = 0xC010;
    h.cpu.f = 0; // NZ
    load(h.mem, 0, 0xCC, 0x00, 0x10); // CALL Z,$1000
    step(h);
    expect(h.cpu.pc).toBe(3);
    expect(h.cpu.sp).toBe(0xC010);
  });

  it('CALL M: taken when S set — pushes return address, jumps', () => {
    const h = newCpu();
    h.cpu.sp = 0xC010;
    h.cpu.f = F_S;
    load(h.mem, 0, 0xFC, 0x00, 0x20); // CALL M,$2000 (y=7)
    step(h);
    expect(h.cpu.pc).toBe(0x2000);
    expect(h.cpu.sp).toBe(0xC00E);
    expect(h.mem[0xC00E]).toBe(0x03); // return at 0x0003
  });

  it('CALL PO: taken when PV clear', () => {
    const h = newCpu();
    h.cpu.sp = 0xC010;
    h.cpu.f = 0; // PV clear → parity odd
    load(h.mem, 0, 0xE4, 0x00, 0x30); // CALL PO,$3000 (y=4)
    step(h);
    expect(h.cpu.pc).toBe(0x3000);
  });

  it('RST: pushes next PC and jumps to restart address (y*8)', () => {
    const h = newCpu();
    h.cpu.sp = 0xC010;
    load(h.mem, 0, 0xEF); // RST $28 (y=5, 5*8=0x28)
    step(h);
    expect(h.cpu.pc).toBe(0x0028);
    expect(h.cpu.sp).toBe(0xC00E);
    expect(h.mem[0xC00E]).toBe(0x01); // return at 0x0001
  });

  it('DI clears both IFF1 and IFF2', () => {
    const h = newCpu();
    h.cpu.iff1 = true; h.cpu.iff2 = true;
    load(h.mem, 0, 0xF3); // DI
    step(h);
    expect(h.cpu.iff1).toBe(false);
    expect(h.cpu.iff2).toBe(false);
  });
});

describe('Z80 — RETN', () => {
  it('pops PC from stack and restores IFF1 from IFF2', () => {
    const h = newCpu();
    h.cpu.sp = 0xC000;
    h.mem[0xC000] = 0x34; h.mem[0xC001] = 0x12; // return to $1234
    h.cpu.iff1 = false; h.cpu.iff2 = true;
    load(h.mem, 0, 0xED, 0x45); // RETN
    step(h);
    expect(h.cpu.pc).toBe(0x1234);
    expect(h.cpu.sp).toBe(0xC002);
    expect(h.cpu.iff1).toBe(true);  // restored from IFF2
    expect(h.cpu.iff2).toBe(true);  // IFF2 unchanged
  });

  it('RETN with IFF2=false leaves interrupts disabled after return', () => {
    const h = newCpu();
    h.cpu.sp = 0xC000;
    h.mem[0xC000] = 0x00; h.mem[0xC001] = 0x00;
    h.cpu.iff1 = false; h.cpu.iff2 = false;
    load(h.mem, 0, 0xED, 0x45);
    step(h);
    expect(h.cpu.iff1).toBe(false);
  });
});

describe('Z80 — IM 0 interrupt', () => {
  it('fires RST 38h, pushes PC, clears IFF1/IFF2, returns 13T', () => {
    const h = newCpu();
    h.cpu.iff1 = true; h.cpu.iff2 = true; h.cpu.im = 0;
    h.cpu.sp = 0xC010; h.cpu.pc = 0xABCD;
    const t = h.cpu.interrupt();
    expect(t).toBe(13);
    expect(h.cpu.pc).toBe(0x0038);
    expect(h.cpu.iff1).toBe(false);
    expect(h.cpu.iff2).toBe(false);
    expect(h.mem[0xC00E]).toBe(0xCD);
    expect(h.mem[0xC00F]).toBe(0xAB);
  });
});
