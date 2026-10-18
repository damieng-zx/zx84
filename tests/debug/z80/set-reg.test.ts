/**
 * Z80DebugService.setReg — the register write path shared by the Debugger
 * pane's click-to-edit and the MCP `set_register` tool.
 *
 * The pane edits every value it shows, so setReg has to cover all of them: the
 * shadow pairs, I/R, the interrupt mode and the interrupt enable.
 */

import { describe, it, expect } from 'vitest';
import { Z80DebugService, type Z80DebugTarget } from '@/debug/z80/service.ts';
import { Z80 } from '@/cores/z80/core.ts';

function make(): { dbg: Z80DebugService; cpu: Z80 } {
  const cpu = new Z80();
  const target = { cpu, memory: { readByte: () => 0 } } as unknown as Z80DebugTarget;
  return { dbg: new Z80DebugService(target), cpu };
}

describe('Z80DebugService.setReg', () => {
  it('writes the shadow pairs, split high/low', () => {
    const { dbg, cpu } = make();
    expect(dbg.setReg("AF'", 0x12C4)).toBe(true);
    expect(dbg.setReg("BC'", 0x3456)).toBe(true);
    expect(dbg.setReg("DE'", 0x789A)).toBe(true);
    expect(dbg.setReg("HL'", 0xBCDE)).toBe(true);
    expect([cpu.a_, cpu.f_]).toEqual([0x12, 0xC4]);
    expect([cpu.b_, cpu.c_]).toEqual([0x34, 0x56]);
    expect([cpu.d_, cpu.e_]).toEqual([0x78, 0x9A]);
    expect([cpu.h_, cpu.l_]).toEqual([0xBC, 0xDE]);
    // ...and reads them back through the snapshot the pane draws from.
    const v = Object.fromEntries(dbg.regs().regs.map(r => [r.name, r.value]));
    expect(v["AF'"]).toBe(0x12C4);
    expect(v["HL'"]).toBe(0xBCDE);
  });

  it('leaves the main registers alone when writing a shadow pair', () => {
    const { dbg, cpu } = make();
    cpu.af = 0x1111;
    dbg.setReg("AF'", 0x2222);
    expect(cpu.af).toBe(0x1111);
  });

  it('writes I and R and masks to a byte', () => {
    const { dbg, cpu } = make();
    dbg.setReg('I', 0x3F);
    dbg.setReg('R', 0x1FF);
    expect(cpu.i).toBe(0x3F);
    expect(cpu.r).toBe(0xFF);
  });

  it('sets the interrupt mode, refusing the non-existent mode 3', () => {
    const { dbg, cpu } = make();
    expect(dbg.setReg('IM', 2)).toBe(true);
    expect(cpu.im).toBe(2);
    expect(dbg.setReg('IM', 3)).toBe(false);
    expect(cpu.im).toBe(2);
  });

  it('moves both interrupt flip-flops together', () => {
    const { dbg, cpu } = make();
    dbg.setReg('IFF', 1);
    expect([cpu.iff1, cpu.iff2]).toEqual([true, true]);
    dbg.setReg('IFF', 0);
    expect([cpu.iff1, cpu.iff2]).toEqual([false, false]);
  });

  it('toggles a single flag through F', () => {
    const { dbg, cpu } = make();
    cpu.f = 0x00;
    dbg.setReg('F', (dbg.getReg('F') as number) ^ 0x40); // Zero
    expect(dbg.regs().flags.find(f => f.name === 'Z')?.set).toBe(true);
    dbg.setReg('F', (dbg.getReg('F') as number) ^ 0x40);
    expect(dbg.regs().flags.find(f => f.name === 'Z')?.set).toBe(false);
  });

  it('still rejects names it does not know', () => {
    const { dbg } = make();
    expect(dbg.setReg('XYZ', 1)).toBe(false);
  });
});
