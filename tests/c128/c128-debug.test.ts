/**
 * The debugger over the 128's two CPUs. The machine starts on the Z80 (its
 * BIOS) and runs on the 8502 once the BIOS sets the MMU's mode register, and
 * the debugger follows whichever runs: registers, disassembly, stepping,
 * breakpoints, watchpoints and the trace are the Z80's while it is in charge
 * and the 8502's after. The ROM-less machine's BIOS is `hand-bios.ts`'s, whose
 * instructions are at known addresses.
 */

import { describe, it, expect } from 'vitest';
import { romImage } from '../snapshot/native-state-helpers.ts';
import { C128Machine } from '@/machines/c128/c128-machine.ts';
import { BIOS_AT, counter, machineRunning } from './hand-bios.ts';

const run = (m: C128Machine, frames: number): void => { for (let f = 0; f < frames; f++) m.tick(); };
const dbg = (m: C128Machine) => m.services.debug;

describe('the Z80 side of the debugger', () => {
  it('reports the Z80 before the BIOS hands over: its family, registers and disassembly', () => {
    const m = machineRunning(counter(0));
    expect(m.cpuIs8502).toBe(false);
    expect(dbg(m).cpuFamily).toBe('z80');
    expect(dbg(m).pc).toBe(0);
    expect(dbg(m).regs().regs.map(r => r.name)).toContain("AF'");
    expect(dbg(m).ports).not.toBeNull();
    expect(dbg(m).disasm(0, 2).map(r => r.text)).toEqual(['LD A,3F', 'LD (FF00),A']);
    expect(dbg(m).disasm(BIOS_AT.ldir, 1)[0].text).toBe('LDIR');
    m.destroy();
  });

  it('steps an instruction with the chips clocked, and pokes registers', () => {
    const m = machineRunning(counter(0));
    const t0 = m.cpu.tStates;
    dbg(m).stepOne();
    expect(dbg(m).pc).toBe(2);
    expect(dbg(m).getReg('A')).toBe(0x3F);
    expect(m.cpu.tStates, 'the master clock moved').toBeGreaterThan(t0);
    dbg(m).stepOne();
    expect(m.memory.mmu.cr, 'LD ($FF00),A reached the MMU').toBe(0x3F);
    expect(dbg(m).setReg('BC', 0x0123)).toBe(true);
    expect(dbg(m).getReg('BC')).toBe(0x0123);
    expect(dbg(m).setReg('X', 1), 'a 6502 register').toBe(false);
    m.destroy();
  });

  it('steps over a block repeat, and out of nothing it is not in', () => {
    const m = machineRunning(counter(0));
    dbg(m).setReg('PC', BIOS_AT.ldBc);
    dbg(m).stepOne();                           // BC = the program's length
    dbg(m).setReg('HL', 0x0030);
    dbg(m).setReg('DE', 0x2000);
    expect(dbg(m).pc).toBe(BIOS_AT.ldir);
    dbg(m).stepOver();
    expect(dbg(m).pc, 'past the whole LDIR').toBe(BIOS_AT.ldir + 2);
    expect(m.memory.ram[0x2000], 'it copied the program').toBe(0xA9);
    m.destroy();
  });

  it('stops the run at a breakpoint on a Z80 address, and resumes from it', () => {
    const m = machineRunning(counter(0));
    m.breakpoints.add(BIOS_AT.crOn);
    run(m, 1);
    expect(m.breakpointHit).toBe(BIOS_AT.crOn);
    expect(m.cpuIs8502, 'still the Z80').toBe(false);
    expect(dbg(m).pc).toBe(BIOS_AT.crOn);
    expect(m.memory.ram[0x1100], 'the copy was done').toBe(0xA9);
    m.breakpoints.delete(BIOS_AT.crOn);
    run(m, 3);
    expect(m.cpuIs8502, 'handed over').toBe(true);
    m.destroy();
  });

  it('stops on a memory watchpoint and a port watchpoint made by the Z80', () => {
    const m = machineRunning(counter(0));
    m.memWatchpoints.push({ start: 0xFF00, end: 0xFF00, mode: 'write' });
    m.runUntil(3);
    expect(m.memWatchHit).toMatchObject({ addr: 0xFF00, value: 0x3F, dir: 'write' });
    m.memWatchpoints.length = 0;
    m.memWatchHit = null;
    m.portWatchpoints.add(0xD505);
    m.runUntil(3);
    expect(m.portWatchHit).toMatchObject({ port: 0xD505, value: 0xB1, dir: 'out' });
    m.destroy();
  });

  it('reads the Z80 view of memory: its BIOS at $0000, which the 8502 does not see', () => {
    const m = machineRunning(counter(0));
    expect(m.memory.z80Snapshot()[0]).toBe(0x3E);
    expect(m.memory.snapshot()[0]).not.toBe(0x3E);
    expect(dbg(m).returnStack(1)).toHaveLength(1);
    m.destroy();
  });
});

describe('the handover, and the 8502 side', () => {
  it('follows the BIOS into the 8502: stepping over the mode register switches the debugger', () => {
    const m = machineRunning(counter(0));
    dbg(m).setReg('PC', BIOS_AT.outMcr - 2);     // LD A,$B1 ; OUT (C),A, with BC = $D505 and I/O on
    dbg(m).setReg('BC', 0xD505);
    m.memory.mmu.cr = 0x3E;
    dbg(m).stepOne();                            // LD A,$B1
    expect(dbg(m).cpuFamily).toBe('z80');
    dbg(m).stepOne();                            // OUT (C),A
    expect(m.cpuIs8502).toBe(true);
    expect(dbg(m).cpuFamily).toBe('m6502');
    expect(dbg(m).regs().regs.map(r => r.name)).toEqual(['A', 'X', 'Y', 'P', 'SP', 'PC']);
    expect(dbg(m).ports, 'a 6502 has no port space').toBeNull();
    m.destroy();
  });

  it('runs the program the BIOS left, and steps and disassembles it as 6502', () => {
    const m = machineRunning(counter(0));
    run(m, 3);
    expect(dbg(m).cpuFamily).toBe('m6502');
    const pc = dbg(m).pc;
    expect(pc).toBeGreaterThanOrEqual(0x1105);
    expect(pc).toBeLessThan(0x1110);
    expect(dbg(m).disasm(0x1105, 1)[0].text).toBe('INC FB');
    expect(dbg(m).setReg('X', 0x42)).toBe(true);
    expect(dbg(m).getReg('X')).toBe(0x42);
    const t0 = m.cpu.tStates;
    dbg(m).stepOne();
    expect(m.cpu.tStates).toBeGreaterThan(t0);
    m.destroy();
  });

  it('stops at a breakpoint in the 8502 program, as before', () => {
    const m = machineRunning(counter(0));
    m.breakpoints.add(0x1105);
    run(m, 4);
    expect(m.breakpointHit).toBe(0x1105);
    expect(dbg(m).pc).toBe(0x1105);
    expect(dbg(m).cpuFamily).toBe('m6502');
    m.destroy();
  });
});

describe('tracing both CPUs', () => {
  it('records the Z80 and then the 8502, each under its heading', () => {
    const m = machineRunning(counter(0, [0xAD, 0x20, 0xD0]));
    m.startTrace('full');
    expect(m.traceActive).toBe(true);
    run(m, 3);
    const text = m.stopTrace();
    expect(m.traceActive).toBe(false);
    expect(text.indexOf('--- Z80 ---')).toBe(0);
    expect(text).toContain('LDIR');
    expect(text).toContain('OUT (C),A');
    expect(text.indexOf('--- 8502 ---')).toBeGreaterThan(text.indexOf('OUT (C),A'));
    expect(text).toContain('INC FB');
    m.destroy();
  });

  it('is the one engine\'s text, unheaded, when only one CPU ran', () => {
    const m = machineRunning(counter(0));
    run(m, 3);                                   // already on the 8502
    m.startTrace('full');
    run(m, 1);
    const text = m.stopTrace();
    expect(text).not.toContain('---');
    expect(text).toContain('INC FB');
    m.destroy();
  });

  it('takes the ZXTL layout for the Z80 only', () => {
    const m = machineRunning(counter(0));
    m.startTrace('zxtl');
    run(m, 3);
    const text = m.stopTrace();
    expect(text).toContain('ZXTL V0001');
    expect(text).not.toContain('INC FB');
    m.destroy();
  });

  it('tallies the Z80\'s port accesses and the 8502\'s I/O page in a port-I/O trace', () => {
    const m = machineRunning(counter(0, [0xAD, 0x20, 0xD0]));
    m.startTrace('portio');
    run(m, 3);
    const text = m.stopTrace();
    expect(text).toContain('--- Z80 ---');
    expect(text).toContain('D505');
    expect(text).toContain('--- 8502 ---');
    expect(text).toContain('D020');
    m.destroy();
  });

  it('offers the debug service\'s trace calls too', () => {
    const m = machineRunning(counter(0));
    dbg(m).startTrace('full');
    expect(dbg(m).traceSession()).toBe('full');
    run(m, 1);
    expect(dbg(m).stopTrace()).toContain('LD A,3F');
    expect(dbg(m).traceSession()).toBeNull();
    m.destroy();
  });
});

const REAL = 'c128-dev/';
const basicLo = romImage(REAL + 'basiclo');
const basicHi = romImage(REAL + 'basichi');
const kernal = romImage(REAL + 'kernal');
const chargen = romImage(REAL + 'chargen');

describe.skipIf(!basicLo || !basicHi || !kernal || !chargen)('the debugger on the real ROMs', () => {
  it('steps the real Z80 BIOS from its first instruction, then the 8502 from its reset vector', () => {
    const m = new C128Machine(null);
    m.loadRoms(basicLo, basicHi, kernal, chargen);
    m.reset();
    expect(dbg(m).cpuFamily).toBe('z80');
    expect(dbg(m).disasm(0, 1)[0].text).toBe('LD A,3E');
    let steps = 0;
    while (!m.memory.mmu.cpu8502 && steps < 200_000) { dbg(m).stepOne(); steps++; }
    expect(m.memory.mmu.cpu8502, 'the BIOS handed over').toBe(true);
    expect(dbg(m).cpuFamily).toBe('m6502');
    expect(dbg(m).pc, 'at the reset vector the BIOS left in RAM').toBe(0x1100);
    m.destroy();
  });
});
