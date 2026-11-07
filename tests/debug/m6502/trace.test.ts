/**
 * The shared 6502 trace engine (src/debug/m6502/trace.ts) against a bare 6502
 * core running a hand-assembled program. Expected registers and cycle counts
 * are worked out by hand from the MOS 6502 programming manual (LDX/LDA #: 2,
 * STA abs,X: 5, DEX: 2, BNE: 2 not taken / 3 taken in-page, STA/LDA abs: 4,
 * JMP abs: 3), not by running the engine.
 */

import { describe, it, expect } from 'vitest';
import { M6502 } from '@/cores/m6502.ts';
import { M6502Trace } from '@/debug/m6502/trace.ts';

/**
 *   0200  A2 03     LDX #03
 *   0202  A9 41     LDA #41
 *   0204  9D 00 03  STA 0300,X
 *   0207  CA        DEX
 *   0208  D0 FA     BNE 0204
 *   020A  8D 00 D0  STA D000      (I/O)
 *   020D  AD 01 D0  LDA D001      (I/O, reads 80)
 *   0210  4C 10 02  JMP 0210
 */
const PROGRAM = [0xA2, 0x03, 0xA9, 0x41, 0x9D, 0x00, 0x03, 0xCA, 0xD0, 0xFA,
  0x8D, 0x00, 0xD0, 0xAD, 0x01, 0xD0, 0x4C, 0x10, 0x02];
const IO: [number, number] = [0xD000, 0xD0FF];

function harness() {
  const cpu = new M6502();
  const mem = new Uint8Array(0x10000);
  mem.set(PROGRAM, 0x0200);
  /** Reads of the I/O page through the machine's memory map (they would have
   *  side effects on real hardware). */
  let memoryIoReads = 0;
  const busRead = (a: number): number => ((a & 0xFF00) === 0xD000 ? 0x80 : mem[a & 0xFFFF]);
  const read = (a: number): number => busRead(a);
  const write = (a: number, v: number): void => { mem[a & 0xFFFF] = v & 0xFF; };
  cpu.read = read;
  cpu.write = write;
  cpu.pc = 0x0200;
  cpu.sp = 0xFF;
  cpu.p = 0x24;
  cpu.tStates = 0;
  const host = {
    cpu,
    memory: {
      readByte: (a: number) => {
        if ((a & 0xFF00) === 0xD000) memoryIoReads++;
        return busRead(a);
      },
    },
  };
  return { cpu, mem, host, read, write, ioReads: () => memoryIoReads };
}

function run(trace: M6502Trace, cpu: M6502, steps: number): void {
  for (let i = 0; i < steps; i++) {
    if (trace.active) trace.before();
    cpu.step();
    if (trace.active) trace.after();
  }
}

const regs = (a: string, x: string, p: string, t: number) => `A=${a} X=${x} Y=00 P=${p} SP=FF T=${t}`;

describe('6502 trace — full mode', () => {
  it('logs address, disassembly, registers and cycles as each instruction starts', () => {
    const { cpu, host, ioReads } = harness();
    const trace = new M6502Trace(host, { io: [IO] });
    trace.start('full');
    run(trace, cpu, 14 + 9); // the program, then 9 more turns of JMP 0210
    const lines = trace.stop().split('\n');
    expect(lines).toEqual([
      `0200  LDX #03        ${regs('00', '00', '24', 0)}`,
      `0202  LDA #41        ${regs('00', '03', '24', 2)}`,
      `0204  STA 0300,X     ${regs('41', '03', '24', 4)}  41→(0303)`,
      `0207  DEX            ${regs('41', '03', '24', 9)}`,
      `0208  BNE 0204       ${regs('41', '02', '24', 11)}  taken`,
      `0204  STA 0300,X     ${regs('41', '02', '24', 14)}  41→(0302)`,
      `0207  DEX            ${regs('41', '02', '24', 19)}`,
      `0208  BNE 0204       ${regs('41', '01', '24', 21)}  taken`,
      `0204  STA 0300,X     ${regs('41', '01', '24', 24)}  41→(0301)`,
      `0207  DEX            ${regs('41', '01', '24', 29)}`,
      // DEX to zero sets Z, so BNE falls through.
      `0208  BNE 0204       ${regs('41', '00', '26', 31)}  --`,
      `020A  STA D000       ${regs('41', '00', '26', 33)}  41→(D000)`,
      // An I/O register is never read by the trace without a side-effect-free peek.
      `020D  LDA D001       ${regs('41', '00', '26', 37)}  (D001)`,
      // LDA of 80 sets N and clears Z.
      `0210  JMP 0210       ${regs('80', '00', 'A4', 41)}`,
      '      ... loops back to 0210 x9',
    ]);
    expect(ioReads()).toBe(0);
  });

  it('reads an I/O operand through the machine\'s peek when it has one', () => {
    const { cpu, mem, host } = harness();
    const peek = (a: number): number => ((a & 0xFF00) === 0xD000 ? 0x5A : mem[a & 0xFFFF]);
    const peekHost = { cpu, memory: { ...host.memory, peekByte: peek } };
    cpu.pc = 0x020D;
    const trace = new M6502Trace(peekHost, { io: [IO] });
    trace.start('full');
    run(trace, cpu, 1);
    expect(trace.stop()).toMatch(/^020D {2}LDA D001 .* {2}\(D001\)=5A$/);
  });

  it('shows the effective address of indirect modes and where an indirect jump goes', () => {
    const { cpu, mem, host } = harness();
    // 0300 B1 10  LDA (10),Y ; 0302 6C FF 04  JMP (04FF) — the NMOS page-wrap bug
    mem.set([0xB1, 0x10, 0x6C, 0xFF, 0x04], 0x0300);
    mem[0x10] = 0x00; mem[0x11] = 0x40; mem[0x4005] = 0x77;
    mem[0x04FF] = 0x34; mem[0x0500] = 0x12; mem[0x0400] = 0x56;
    cpu.pc = 0x0300;
    cpu.y = 5;
    const trace = new M6502Trace(host, { io: [IO] });
    trace.start('full');
    run(trace, cpu, 2);
    const lines = trace.stop().split('\n');
    expect(lines[0]).toMatch(/^0300 {2}LDA \(10\),Y .* {2}\(4005\)=77$/);
    // The high byte comes from 0400, not 0500.
    expect(lines[1]).toMatch(/^0302 {2}JMP \(04FF\) .* {2}→5634$/);
  });

  it('marks a step that enters an interrupt instead of running the instruction', () => {
    const { cpu, mem, host } = harness();
    mem[0xFFFE] = 0x00; mem[0xFFFF] = 0x06; // IRQ vector 0600
    mem[0x0600] = 0xEA; // NOP
    cpu.p = 0x20; // I clear
    cpu.setIRQ(true);
    const trace = new M6502Trace(host, { io: [IO] });
    trace.start('full');
    run(trace, cpu, 1);
    cpu.setIRQ(false);
    run(trace, cpu, 1);
    const lines = trace.stop().split('\n');
    expect(lines[0]).toBe(`0200  <IRQ>          A=00 X=00 Y=00 P=20 SP=FF T=0`);
    // Entry pushed PC and P (SP FF → FC), set I, and took 7 cycles.
    expect(lines[1]).toBe(`0600  NOP            A=00 X=00 Y=00 P=24 SP=FC T=7`);
  });

  it('stops capturing at the cap and marks the trace truncated', () => {
    const { cpu, host } = harness();
    const trace = new M6502Trace(host, { io: [IO], maxLines: 3 });
    trace.start('full');
    run(trace, cpu, 10);
    expect(trace.active).toBe(false);
    const lines = trace.stop().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('      ... trace truncated: stopped capturing at 3 lines');
  });
});

describe('6502 trace — portio mode', () => {
  it('tallies CPU accesses inside the I/O window only, by address', () => {
    const { cpu, host, read, write } = harness();
    const trace = new M6502Trace(host, { io: [IO], ioLabel: a => (a === 0xD000 ? 'GTIA' : '') });
    trace.start('portio');
    run(trace, cpu, 16);
    expect(trace.stop()).toBe([
      '=== I/O Access Summary ===', '',
      'READ:', '  D001         1x         from 020D  vals 80', '',
      'WRITE:', '  D000         1x  GTIA   from 020A  vals 41', '',
    ].join('\n'));
    // The bus callbacks are the machine's own again.
    expect(cpu.read).toBe(read);
    expect(cpu.write).toBe(write);
  });
});

describe('6502 trace — modes', () => {
  it('offers full and portio; zxtl (a Z80 layout) is refused and starts nothing', () => {
    const { host } = harness();
    const trace = new M6502Trace(host, { io: [IO] });
    expect(trace.supports('full')).toBe(true);
    expect(trace.supports('portio')).toBe(true);
    expect(trace.supports('zxtl')).toBe(false);
    trace.start('zxtl');
    expect(trace.active).toBe(false);
    expect(trace.session).toBeNull();
  });
});
