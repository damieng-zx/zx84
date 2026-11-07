/**
 * The shared Z80 trace engine (src/debug/z80/trace.ts) against a bare Z80 core
 * running a hand-assembled program. Every expected line is worked out by hand
 * from the Z80 instruction set (register effects and T-state counts from the
 * Zilog Z80 CPU User Manual), not by running the engine.
 */

import { describe, it, expect } from 'vitest';
import { Z80 } from '@/cores/z80.ts';
import { Z80Trace } from '@/debug/z80/trace.ts';

/**
 *   8000  3E 05     LD A,05
 *   8002  06 03     LD B,03
 *   8004  21 00 90  LD HL,9000
 *   8007  77        LD (HL),A
 *   8008  23        INC HL
 *   8009  10 FC     DJNZ 8007
 *   800B  D3 FE     OUT (FE),A
 *   800D  DB 7F     IN A,(7F)
 *   800F  18 FE     JR 800F
 */
const PROGRAM = [0x3E, 0x05, 0x06, 0x03, 0x21, 0x00, 0x90, 0x77, 0x23, 0x10, 0xFC, 0xD3, 0xFE, 0xDB, 0x7F, 0x18, 0xFE];

function harness() {
  const cpu = new Z80();
  const mem = new Uint8Array(0x10000);
  mem.set(PROGRAM, 0x8000);
  cpu.read8 = (a) => mem[a & 0xFFFF];
  cpu.write8 = (a, v) => { mem[a & 0xFFFF] = v & 0xFF; };
  const outs: [number, number][] = [];
  const inHandler = (_p: number): number => 0x42;
  const outHandler = (p: number, v: number): void => { outs.push([p, v]); };
  cpu.portInHandler = inHandler;
  cpu.portOutHandler = outHandler;
  cpu.pc = 0x8000;
  cpu.sp = 0xFF00;
  const host = { cpu, memory: { readByte: (a: number) => mem[a & 0xFFFF] } };
  return { cpu, mem, host, outs, inHandler, outHandler };
}

/** Drive the engine the way a frame loop does. */
function run(trace: Z80Trace, cpu: Z80, steps: number): void {
  for (let i = 0; i < steps; i++) {
    if (trace.active) trace.before();
    cpu.step();
    if (trace.active) trace.after();
  }
}

const regs = (af: string, bc: string, hl: string, t: number) =>
  `AF=${af} BC=${bc} DE=0000 HL=${hl} IX=0000 IY=0000 SP=FF00 T=${t}`;

describe('Z80 trace — full mode', () => {
  it('logs address, disassembly, registers and T-states as each instruction starts', () => {
    const { cpu, host } = harness();
    const trace = new Z80Trace(host);
    trace.start('full');
    run(trace, cpu, 15 + 20); // the program, then 20 turns of JR 800F
    const lines = trace.stop().split('\n');
    expect(lines).toEqual([
      `8000  LD A,05            ${regs('0000', '0000', '0000', 0)}`,
      `8002  LD B,03            ${regs('0500', '0000', '0000', 7)}`,
      `8004  LD HL,9000         ${regs('0500', '0300', '0000', 14)}`,
      `8007  LD (HL),A          ${regs('0500', '0300', '9000', 24)}  05→(9000)`,
      `8008  INC HL             ${regs('0500', '0300', '9000', 31)}`,
      `8009  DJNZ 8007          ${regs('0500', '0300', '9001', 37)}  B=03`,
      `8007  LD (HL),A          ${regs('0500', '0200', '9001', 50)}  05→(9001)`,
      `8008  INC HL             ${regs('0500', '0200', '9001', 57)}`,
      `8009  DJNZ 8007          ${regs('0500', '0200', '9002', 63)}  B=02`,
      `8007  LD (HL),A          ${regs('0500', '0100', '9002', 76)}  05→(9002)`,
      `8008  INC HL             ${regs('0500', '0100', '9002', 83)}`,
      `8009  DJNZ 8007          ${regs('0500', '0100', '9003', 89)}  B=01`,
      `800B  OUT (FE),A         ${regs('0500', '0000', '9003', 97)}  A=05`,
      `800D  IN A,(7F)          ${regs('0500', '0000', '9003', 108)}`,
      // IN A,(n) loads A from the port and leaves F alone.
      `800F  JR 800F            ${regs('4200', '0000', '9003', 119)}`,
      // The 20 later turns of JR 800F repeat with the same registers: folded.
      '      ... loops back to 800F x20',
    ]);
  });

  it('a conditional jump reports whether it is taken, read before it runs', () => {
    const { cpu, mem, host } = harness();
    // 8000 AF  XOR A (Z set) ; 8001 28 01  JR Z,8004 ; 8003 00 ; 8004 20 FE  JR NZ,8004 ; 8006 00
    mem.set([0xAF, 0x28, 0x01, 0x00, 0x20, 0xFE, 0x00], 0x8000);
    const trace = new Z80Trace(host);
    trace.start('full');
    run(trace, cpu, 3);
    const lines = trace.stop().split('\n');
    expect(lines[1]).toMatch(/^8001  JR Z,8004 .* {2}taken$/);
    expect(lines[2]).toMatch(/^8004  JR NZ,8004 .* {2}--$/);
  });

  it('stops capturing at the cap and marks the trace truncated', () => {
    const { cpu, host } = harness();
    const trace = new Z80Trace(host, { maxLines: 4 });
    trace.start('full');
    run(trace, cpu, 10);
    expect(trace.active).toBe(false);
    expect(trace.session).toBe('full'); // still open for stop()
    const lines = trace.stop().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[3]).toMatch(/^8007  LD \(HL\),A/);
    expect(lines[4]).toBe('      ... trace truncated: stopped capturing at 4 lines');
    expect(trace.session).toBeNull();
  });

  it('a new trace starts from a clean slate', () => {
    const { cpu, host } = harness();
    const trace = new Z80Trace(host);
    trace.start('full');
    run(trace, cpu, 3);
    trace.stop();
    cpu.pc = 0x8000;
    trace.start('full');
    run(trace, cpu, 1);
    expect(trace.stop()).toMatch(/^8000  LD A,05 /);
  });
});

describe('Z80 trace — portio mode', () => {
  it('tallies IN and OUT by full port address, against the instruction that made them', () => {
    const { cpu, host, outs, inHandler, outHandler } = harness();
    const trace = new Z80Trace(host);
    trace.start('portio');
    run(trace, cpu, 15);
    const out = trace.stop();
    // OUT (n),A puts A on the high byte: port 05FE, value 05. IN A,(n) the same: 057F.
    expect(out).toBe([
      '=== Port IO Summary ===', '',
      'IN:', '  057F         1x         from 800D  vals 42', '',
      'OUT:', '  05FE         1x         from 800B  vals 05', '',
    ].join('\n'));
    // The tap forwarded the access and is gone again.
    expect(outs).toEqual([[0x05FE, 0x05]]);
    expect(cpu.portInHandler).toBe(inHandler);
    expect(cpu.portOutHandler).toBe(outHandler);
  });

  it('taps a machine that installs its own portIn/portOut, and names ports', () => {
    const { cpu, host } = harness();
    const ownIn = (_p: number): number => 0x99;
    const ownOut = (_p: number, _v: number): void => {};
    cpu.portIn = ownIn;
    cpu.portOut = ownOut;
    const trace = new Z80Trace(host, { portLabel: p => ((p & 0xFF) === 0xFE ? 'ULA' : '') });
    trace.start('portio');
    run(trace, cpu, 15);
    const out = trace.stop();
    expect(out).toContain('  057F         1x         from 800D  vals 99');
    expect(out).toContain('  05FE         1x  ULA    from 800B  vals 05');
    expect(cpu.portIn).toBe(ownIn);
    expect(cpu.portOut).toBe(ownOut);
  });

  it('logs no instruction lines', () => {
    const { cpu, host } = harness();
    const trace = new Z80Trace(host);
    trace.start('portio');
    run(trace, cpu, 3);
    expect(trace.buffer).toEqual([]);
  });
});

describe('Z80 trace — zxtl mode', () => {
  it('writes the ZXTL header, then the registers after each instruction', () => {
    const { cpu, host } = harness();
    const trace = new Z80Trace(host);
    trace.start('zxtl');
    run(trace, cpu, 7);
    const lines = trace.stop().split('\n');
    expect(lines[0]).toMatch(/^ZXTL V0001/);
    expect(lines[1]).toMatch(/^J {3}Cycle Addr\./);
    // LD A,05 at 32768: 7 T-states, then A=05, PC=8002, one M1 so R=01.
    expect(lines[2]).toBe(
      '        7 32768 3E 05 06 03 LD A,05              05 00 00 00 00 00 00 00 00 00 00 00 FF00 8002 00 00 00 01');
    // DJNZ 8007 at 32777 (taken): B=02, PC back at 8007.
    expect(lines[7]).toMatch(/^ {7}50 32777 10 FC D3 FE DJNZ 8007 +05 00 02 00 00 00 90 01 .* FF00 8007 /);
    // The instruction after a taken jump is flagged.
    expect(lines[8]).toMatch(/^\* +57 32775 77 /);
    expect(lines).toHaveLength(9);
  });
});

describe('Z80 trace — modes', () => {
  it('offers full, portio and zxtl, and ignores anything else', () => {
    const { host } = harness();
    const trace = new Z80Trace(host);
    expect(['full', 'portio', 'zxtl'].every(m => trace.supports(m))).toBe(true);
    expect(trace.supports('bogus')).toBe(false);
  });
});
