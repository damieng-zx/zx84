import { describe, it, expect } from 'vitest';
import { Cop420, cop420Disassemble, type Cop420Pins } from '@/cores/cop420.ts';

const NOP = 0x44;

/** A 1K ROM of NOPs with the given byte runs placed at their addresses. */
function makeRom(parts: Record<number, number[]> = {}): Uint8Array {
  const rom = new Uint8Array(1024).fill(NOP);
  for (const [addr, bytes] of Object.entries(parts)) rom.set(bytes, Number(addr));
  return rom;
}

/** A chip on a bench: input levels the test drives, and a log of every output. */
function bench(parts: Record<number, number[]> = {}) {
  const io = {
    g: 0xF, inp: 0xF, l: 0, si: 0,
    gw: [] as number[], dw: [] as number[], lw: [] as number[],
    so: [] as number[], sk: [] as number[],
  };
  const pins: Cop420Pins = {
    readG: () => io.g,
    readIN: () => io.inp,
    readL: () => io.l,
    readSI: () => io.si,
    writeG: v => { io.gw.push(v); },
    writeD: v => { io.dw.push(v); },
    writeL: v => { io.lw.push(v); },
    writeSO: v => { io.so.push(v); },
    writeSK: v => { io.sk.push(v); },
  };
  const cpu = new Cop420(makeRom(parts), pins);
  cpu.reset();
  io.so.length = 0;                   // the reset drive of SO / SK is not under test
  io.sk.length = 0;
  return { cpu, io };
}

function run(cpu: Cop420, n: number): number {
  let cycles = 0;
  for (let i = 0; i < n; i++) cycles += cpu.step();
  return cycles;
}

describe('COP420 — reset', () => {
  it('clears PC/A/B/C/G/D/EN, sets SKL and the timer latch, and drives the outputs', () => {
    const { cpu, io } = bench();
    expect(cpu.pc).toBe(0);
    expect([cpu.a, cpu.b, cpu.c, cpu.g, cpu.d, cpu.en]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(cpu.skl).toBe(1);
    expect(cpu.t).toBe(0);
    expect(cpu.skt).toBe(true);
    expect(io.gw).toEqual([0]);
    expect(io.dw).toEqual([0]);
  });

  it('leaves Q, the stack, SIO, IL and RAM alone', () => {
    const { cpu } = bench();
    cpu.q = 0x5C; cpu.sa = 0x123; cpu.sb = 0x234; cpu.sc = 0x345; cpu.sio = 9; cpu.il = 5;
    cpu.ram[7] = 0xA;
    cpu.pc = 0x77; cpu.a = 3; cpu.en = 0xF;
    cpu.reset();
    expect([cpu.q, cpu.sa, cpu.sb, cpu.sc, cpu.sio, cpu.il, cpu.ram[7]])
      .toEqual([0x5C, 0x123, 0x234, 0x345, 9, 5, 0xA]);
    expect([cpu.pc, cpu.a, cpu.en]).toEqual([0, 0, 0]);
  });
});

describe('COP420 — arithmetic and skips', () => {
  it('AISC skips on carry out of the nibble and leaves C alone', () => {
    const { cpu } = bench({ 0: [0x51, 0x22, 0x32] });   // AISC 1; SC; RC
    cpu.a = 0xF;
    expect(run(cpu, 1)).toBe(1);
    expect(cpu.a).toBe(0);
    expect(cpu.c).toBe(0);
    expect(cpu.skip).toBe(true);
    expect(run(cpu, 1)).toBe(1);                         // SC skipped
    expect(cpu.c).toBe(0);
    expect(cpu.pc).toBe(2);
    expect(cpu.skip).toBe(false);
  });

  it('AISC without carry does not skip', () => {
    const { cpu } = bench({ 0: [0x5F, 0x22] });          // AISC 15; SC
    cpu.a = 0;
    run(cpu, 2);
    expect(cpu.a).toBe(0xF);
    expect(cpu.c).toBe(1);                               // SC ran
  });

  it('ASC adds M and C, sets C from the carry, and skips on it', () => {
    const { cpu } = bench({ 0: [0x30] });
    cpu.a = 9; cpu.ram[0] = 8; cpu.c = 1;                // 9 + 8 + 1 = 18
    run(cpu, 1);
    expect([cpu.a, cpu.c, cpu.skip]).toEqual([2, 1, true]);
  });

  it('ASC without carry clears C', () => {
    const { cpu } = bench({ 0: [0x30] });
    cpu.a = 2; cpu.ram[0] = 3; cpu.c = 0;
    run(cpu, 1);
    expect([cpu.a, cpu.c, cpu.skip]).toEqual([5, 0, false]);
  });

  it('CASC adds the complement of A: 3 -> 12, + 4 = 16 carries', () => {
    const { cpu } = bench({ 0: [0x10] });
    cpu.a = 3; cpu.ram[0] = 4; cpu.c = 0;
    run(cpu, 1);
    expect([cpu.a, cpu.c, cpu.skip]).toEqual([0, 1, true]);
  });

  it('CASC without carry: 3 -> 12, + 2 = 14', () => {
    const { cpu } = bench({ 0: [0x10] });
    cpu.a = 3; cpu.ram[0] = 2; cpu.c = 0;
    run(cpu, 1);
    expect([cpu.a, cpu.c, cpu.skip]).toEqual([14, 0, false]);
  });

  it('ADD wraps with no carry and no skip', () => {
    const { cpu } = bench({ 0: [0x31] });
    cpu.a = 9; cpu.ram[0] = 8;
    run(cpu, 1);
    expect([cpu.a, cpu.c, cpu.skip]).toEqual([1, 0, false]);
  });

  it('ADT adds ten modulo 16', () => {
    const { cpu } = bench({ 0: [0x4A, 0x4A] });
    cpu.a = 7;
    run(cpu, 1);
    expect(cpu.a).toBe(1);
    cpu.a = 3;
    run(cpu, 1);
    expect(cpu.a).toBe(13);
  });

  it('COMP, CLRA and XOR', () => {
    const { cpu } = bench({ 0: [0x40, 0x02, 0x00] });
    cpu.a = 0x5; cpu.ram[0] = 0xC;
    run(cpu, 1); expect(cpu.a).toBe(0xA);
    run(cpu, 1); expect(cpu.a).toBe(0xA ^ 0xC);
    run(cpu, 1); expect(cpu.a).toBe(0);
  });

  it('SKE, SKC, SC and RC', () => {
    const { cpu } = bench({ 0: [0x21, 0x44, 0x21, 0x44, 0x22, 0x20, 0x44, 0x32, 0x20] });
    cpu.a = 5; cpu.ram[0] = 5;
    run(cpu, 1); expect(cpu.skip).toBe(true);            // SKE: equal
    run(cpu, 1);                                         // skipped NOP
    cpu.ram[0] = 6;
    run(cpu, 1); expect(cpu.skip).toBe(false);           // SKE: unequal
    run(cpu, 1);                                         // NOP
    run(cpu, 1); expect(cpu.c).toBe(1);                  // SC
    run(cpu, 1); expect(cpu.skip).toBe(true);            // SKC
    run(cpu, 2);                                         // skipped NOP, RC
    expect(cpu.c).toBe(0);
    run(cpu, 1); expect(cpu.skip).toBe(false);           // SKC, C clear
  });

  it('CAB, CBA and XABR move A and B', () => {
    const { cpu } = bench({ 0: [0x50, 0x4E, 0x12] });
    cpu.b = 0x2B; cpu.a = 7;
    run(cpu, 1); expect(cpu.b).toBe(0x27);               // CAB: Bd <- A
    run(cpu, 1); expect(cpu.a).toBe(7);                  // CBA: A <- Bd
    cpu.b = 0x2B; cpu.a = 7;
    run(cpu, 1);                                         // XABR: A <-> Br
    expect(cpu.a).toBe(2);
    expect(cpu.b).toBe(0x3B);                            // Br <- A1:0 = 3
  });
});

describe('COP420 — RAM addressing', () => {
  it('XIS exchanges, increments Bd, and skips when Bd wraps 15 -> 0', () => {
    const { cpu } = bench({ 0: [0x04, 0x44] });
    cpu.b = 0x1F; cpu.ram[0x1F] = 7; cpu.a = 3;
    run(cpu, 1);
    expect([cpu.a, cpu.ram[0x1F]]).toEqual([7, 3]);
    expect(cpu.b).toBe(0x10);                            // Bd wrapped, Br untouched
    expect(cpu.skip).toBe(true);
    expect(run(cpu, 1)).toBe(1);
    expect(cpu.pc).toBe(2);
  });

  it('XIS does not skip without a wrap', () => {
    const { cpu } = bench({ 0: [0x04] });
    cpu.b = 0x05;
    run(cpu, 1);
    expect([cpu.b, cpu.skip]).toEqual([0x06, false]);
  });

  it('XDS decrements Bd and skips when Bd wraps 0 -> 15', () => {
    const { cpu } = bench({ 0: [0x07] });
    cpu.b = 0x20; cpu.ram[0x20] = 4; cpu.a = 9;
    run(cpu, 1);
    expect([cpu.a, cpu.ram[0x20]]).toEqual([4, 9]);
    expect(cpu.b).toBe(0x2F);
    expect(cpu.skip).toBe(true);
  });

  it('XIS r XORs r into Br', () => {
    const { cpu } = bench({ 0: [0x34] });
    cpu.b = 0x00;
    run(cpu, 1);
    expect(cpu.b).toBe(0x31);                            // Bd 0 -> 1, Br 0 ^ 3
  });

  it('LD r loads A and XORs r into Br; X r exchanges and XORs', () => {
    const { cpu } = bench({ 0: [0x15, 0x26] });
    cpu.b = 0x00; cpu.ram[0] = 9;
    run(cpu, 1);
    expect([cpu.a, cpu.b]).toEqual([9, 0x10]);
    cpu.a = 2; cpu.ram[0x10] = 6;
    run(cpu, 1);                                         // X 2: Br 1 ^ 2 = 3
    expect([cpu.a, cpu.ram[0x10], cpu.b]).toEqual([6, 2, 0x30]);
  });

  it('LDD / XAD address RAM directly and leave B alone', () => {
    const { cpu } = bench({ 0: [0x23, 0x1F, 0x23, 0xA3] });
    cpu.b = 0x05; cpu.ram[0x1F] = 0xC; cpu.ram[0x23] = 0x3;
    expect(run(cpu, 1)).toBe(2);
    expect([cpu.a, cpu.b]).toEqual([0xC, 0x05]);
    cpu.a = 0x8;
    expect(run(cpu, 1)).toBe(2);
    expect([cpu.a, cpu.ram[0x23], cpu.b]).toEqual([0x3, 0x8, 0x05]);
  });

  it('STII stores the immediate and increments Bd without skipping', () => {
    const { cpu } = bench({ 0: [0x7C] });
    cpu.b = 0x2F;
    run(cpu, 1);
    expect(cpu.ram[0x2F]).toBe(0xC);
    expect(cpu.b).toBe(0x20);
    expect(cpu.skip).toBe(false);
  });

  it('SMB / RMB / SKMBZ work on the four bits of M', () => {
    const { cpu } = bench({ 0: [0x46, 0x03, 0x44, 0x11, 0x44, 0x45, 0x4C, 0x4B, 0x43] });
    cpu.ram[0] = 0;
    run(cpu, 1); expect(cpu.ram[0]).toBe(0b0100);        // SMB2
    run(cpu, 1); expect(cpu.skip).toBe(false);           // SKMBZ2: bit set
    run(cpu, 1);                                         // NOP
    run(cpu, 1); expect(cpu.skip).toBe(true);            // SKMBZ1: bit clear
    run(cpu, 1);                                         // skipped NOP
    cpu.ram[0] = 0b1111;
    run(cpu, 1); expect(cpu.ram[0]).toBe(0b1101);        // RMB1
    run(cpu, 1); expect(cpu.ram[0]).toBe(0b1100);        // RMB0
    cpu.ram[0] = 0; run(cpu, 1); expect(cpu.ram[0]).toBe(0b1000);   // SMB3
    run(cpu, 1); expect(cpu.ram[0]).toBe(0);             // RMB3
  });
});

describe('COP420 — LBI', () => {
  it('one-byte LBI: 00rr1ddd gives Bd = 9..15, 0', () => {
    const { cpu } = bench({ 0: [0x08, 0x44, 0x0F, 0x44, 0x3E] });
    run(cpu, 1); expect(cpu.b).toBe(0x09);               // LBI 0,9
    run(cpu, 1);                                         // NOP ends the chain
    run(cpu, 1); expect(cpu.b).toBe(0x00);               // LBI 0,0
    run(cpu, 1);
    run(cpu, 1); expect(cpu.b).toBe(0x3F);               // LBI 3,15
  });

  it('only the first of consecutive LBIs executes', () => {
    const { cpu } = bench({ 0: [0x08, 0x19, 0x2A, 0x00, 0x3E] });
    run(cpu, 1); expect(cpu.b).toBe(0x09);
    expect(run(cpu, 1)).toBe(1); expect(cpu.b).toBe(0x09); expect(cpu.pc).toBe(2);
    expect(run(cpu, 1)).toBe(1); expect(cpu.b).toBe(0x09); expect(cpu.pc).toBe(3);
    run(cpu, 1); expect(cpu.a).toBe(0);                  // CLRA executed normally
    run(cpu, 1); expect(cpu.b).toBe(0x3F);               // chain over: this LBI runs
  });

  it('two-byte LBI takes any r,d', () => {
    const { cpu } = bench({ 0: [0x33, 0x9A] });
    expect(run(cpu, 1)).toBe(2);
    expect(cpu.b).toBe(0x1A);
  });
});

describe('COP420 — jumps, calls and the stack', () => {
  it('JP stays in the current 64-byte page', () => {
    const { cpu } = bench({ 0x45: [0xD0] });
    cpu.pc = 0x45;
    expect(run(cpu, 1)).toBe(1);
    expect(cpu.pc).toBe(0x50);                           // page 1 (0x40), low bits 0x10
    const b2 = bench({ 0xE0: [0xC5] });
    b2.cpu.pc = 0xE0;
    run(b2.cpu, 1);
    expect(b2.cpu.pc).toBe(0xC5);                        // page 3
  });

  it('sequential fetch carries on into the next page', () => {
    // The NewBrain firmware has a two-byte LBI at 23E-23F whose successor is at
    // 240: execution does not wrap back to the start of the 64-byte page.
    const { cpu } = bench();
    cpu.pc = 0x3F;
    run(cpu, 1);
    expect(cpu.pc).toBe(0x40);
    cpu.pc = 0x3FF;
    run(cpu, 1);
    expect(cpu.pc).toBe(0x000);                          // only the 10-bit counter wraps
  });

  it('a JP in the last byte of a page jumps within the next page', () => {
    // The PC is already incremented when the jump replaces its low six bits.
    const { cpu } = bench({ 0x3F: [0xC5] });
    cpu.pc = 0x3F;
    run(cpu, 1);
    expect(cpu.pc).toBe(0x45);
  });

  it('inside pages 2 and 3 a 1xxxxxxx opcode is a seven-bit JP, not a JSRP', () => {
    // Page 2/3 have no JSRP: 0x94 at 0x90 reaches 0x94, 0xD4 reaches page 3,
    // and nothing is pushed.
    const a = bench({ 0x90: [0x94] });
    a.cpu.pc = 0x90;
    expect(run(a.cpu, 1)).toBe(1);
    expect(a.cpu.pc).toBe(0x94);
    expect(a.cpu.sa).toBe(0);
    const b = bench({ 0x83: [0xD4] });
    b.cpu.pc = 0x83;
    run(b.cpu, 1);
    expect(b.cpu.pc).toBe(0xD4);
    expect(b.cpu.sa).toBe(0);
    // Page 4 and up keep the JSRP.
    const c = bench({ 0x100: [0x94] });
    c.cpu.pc = 0x100;
    run(c.cpu, 1);
    expect(c.cpu.pc).toBe(0x94);
    expect(c.cpu.sa).toBe(0x101);
  });

  it('JMP and JSR take a 10-bit address in two cycles', () => {
    const { cpu } = bench({ 0: [0x62, 0xA5], 0x2A5: [0x69, 0x23] });
    expect(run(cpu, 1)).toBe(2);
    expect(cpu.pc).toBe(0x2A5);
    expect(run(cpu, 1)).toBe(2);
    expect(cpu.pc).toBe(0x123);
    expect(cpu.sa).toBe(0x2A7);
  });

  it('JSR at the end of a page pushes the address of the next page', () => {
    const { cpu } = bench({ 0x3E: [0x6B, 0x00] });
    cpu.pc = 0x3E;
    run(cpu, 1);
    expect(cpu.pc).toBe(0x300);
    expect(cpu.sa).toBe(0x040);                          // 0x3E,0x3F consumed; next is 0x40
  });

  it('JSRP calls page 2 and RET comes back', () => {
    const { cpu } = bench({ 0x100: [0x85], 0x85: [0x48] });
    cpu.pc = 0x100;
    expect(run(cpu, 1)).toBe(1);
    expect(cpu.pc).toBe(0x85);
    expect(cpu.sa).toBe(0x101);
    expect(run(cpu, 1)).toBe(1);
    expect(cpu.pc).toBe(0x101);
  });

  it('RETSK returns and skips the next instruction', () => {
    const { cpu } = bench({ 0: [0x68, 0x10], 0x10: [0x49], 2: [0x22, 0x32] });
    run(cpu, 2);                                         // JSR 010; RETSK
    expect(cpu.pc).toBe(2);
    expect(cpu.skip).toBe(true);
    run(cpu, 1);                                         // SC skipped
    expect(cpu.c).toBe(0);
    run(cpu, 1);                                         // RC
    expect(cpu.pc).toBe(4);
  });

  it('the stack is three deep: a fourth call loses the oldest return address', () => {
    const { cpu } = bench({
      0x000: [0x69, 0x00],
      0x100: [0x6A, 0x00],
      0x200: [0x6B, 0x00],
      0x300: [0x69, 0x80],
      0x180: [0x48],
      0x302: [0x48], 0x202: [0x48], 0x102: [0x48],
    });
    run(cpu, 4);                                         // four JSRs
    expect(cpu.pc).toBe(0x180);
    expect([cpu.sa, cpu.sb, cpu.sc]).toEqual([0x302, 0x202, 0x102]);   // 0x002 is gone
    const pcs: number[] = [];
    for (let i = 0; i < 4; i++) { run(cpu, 1); pcs.push(cpu.pc); }
    // SC is not cleared by a pop, so the fourth RET repeats the last address.
    expect(pcs).toEqual([0x302, 0x202, 0x102, 0x102]);
  });

  it('LQID loads Q from the A:M lookup in this 256-byte page, with no net stack change', () => {
    const { cpu, io } = bench({ 0x100: [0xBF], 0x135: [0xA7] });
    cpu.pc = 0x100; cpu.a = 3; cpu.ram[0] = 5;
    cpu.sa = 0x55; cpu.sb = 0x66; cpu.sc = 0x77;
    expect(run(cpu, 1)).toBe(2);
    expect(cpu.q).toBe(0xA7);
    expect(cpu.pc).toBe(0x101);
    expect([cpu.sa, cpu.sb, cpu.sc]).toEqual([0x55, 0x66, 0x77]);
    expect(io.lw).toEqual([]);                           // EN2 clear: L not driven
  });

  it('LQID drives L when EN2 is set', () => {
    const { cpu, io } = bench({ 0x135: [0xA7], 0x100: [0xBF] });
    cpu.pc = 0x100; cpu.a = 3; cpu.ram[0] = 5; cpu.en = 4;
    run(cpu, 1);
    expect(io.lw).toEqual([0xA7]);
  });

  it('JID jumps to the low byte read from the A:M table', () => {
    const { cpu } = bench({ 0x100: [0xFF], 0x135: [0x77] });
    cpu.pc = 0x100; cpu.a = 3; cpu.ram[0] = 5;
    expect(run(cpu, 1)).toBe(2);
    expect(cpu.pc).toBe(0x177);
    expect(cpu.sa).toBe(0);                              // nothing pushed
  });
});

describe('COP420 — timer', () => {
  it('overflows after exactly 1024 cycles and SKT tests and clears the latch', () => {
    const { cpu } = bench({ 0x20: [0x41] });
    cpu.skt = false; cpu.t = 0;
    run(cpu, 1023);
    expect(cpu.skt).toBe(false);
    run(cpu, 1);
    expect(cpu.skt).toBe(true);
    expect(cpu.t).toBe(0);
    cpu.pc = 0x20;
    run(cpu, 1);
    expect(cpu.skip).toBe(true);
    expect(cpu.skt).toBe(false);
    cpu.skip = false; cpu.pc = 0x20;
    run(cpu, 1);
    expect(cpu.skip).toBe(false);                        // latch already cleared
  });

  it('counts both cycles of a two-cycle instruction', () => {
    const { cpu } = bench({ 0: [0x60, 0x00] });          // JMP 000 forever
    cpu.skt = false; cpu.t = 0;
    run(cpu, 512);
    expect(cpu.skt).toBe(true);
  });
});

describe('COP420 — IN1 interrupt', () => {
  it('a falling edge on IN1 with EN1 set vectors to 0x0FF, clearing EN1 and IL1', () => {
    const { cpu, io } = bench();
    cpu.en = 2;
    run(cpu, 1);                                         // NOP, pc 1
    io.inp = 0xD;                                        // IN1 falls
    expect(run(cpu, 1)).toBe(1);
    expect(cpu.pc).toBe(0x0FF);
    expect(cpu.sa).toBe(1);                              // the instruction not yet executed
    expect(cpu.en & 2).toBe(0);
    expect(cpu.il & 2).toBe(0);
  });

  it('is latched but not taken while EN1 is clear', () => {
    const { cpu, io } = bench();
    run(cpu, 1);
    io.inp = 0xD;
    run(cpu, 2);
    expect(cpu.pc).toBe(3);
    expect(cpu.il & 2).toBe(2);
    cpu.en = 2;                                          // enabling it releases the latch
    run(cpu, 1);
    expect(cpu.pc).toBe(0x0FF);
  });

  it('a level held low is one edge, not a stream of interrupts', () => {
    const { cpu, io } = bench({ 0xFF: [0x48] });
    cpu.en = 2;
    io.inp = 0xD;
    run(cpu, 1);                                         // the falling edge: interrupt taken
    expect(cpu.pc).toBe(0x0FF);
    cpu.en = 2;                                          // re-enabled while IN1 is still low
    run(cpu, 5);                                         // RET to 0, then four NOPs
    expect(cpu.pc).toBe(4);
    io.inp = 0xF;                                        // released ...
    run(cpu, 1);
    io.inp = 0xD;                                        // ... and pulled low again: a new edge
    run(cpu, 1);
    expect(cpu.pc).toBe(0x0FF);
  });

  it('waits for a transfer of control to finish', () => {
    const { cpu, io } = bench({ 0: [0xC5] });            // JP 005
    cpu.en = 2;
    run(cpu, 0);
    io.inp = 0xD;
    run(cpu, 1);                                         // JP runs, interrupt deferred
    expect(cpu.pc).toBe(5);
    run(cpu, 1);
    expect(cpu.pc).toBe(0x0FF);
    expect(cpu.sa).toBe(5);
  });

  it('waits for RET and for a following run of LBIs', () => {
    const a = bench({ 0: [0x48] });
    a.cpu.en = 2; a.cpu.sa = 0x20;
    a.io.inp = 0xD;
    run(a.cpu, 1);
    expect(a.cpu.pc).toBe(0x20);                         // RET executed first
    run(a.cpu, 1);
    expect(a.cpu.pc).toBe(0x0FF);

    const b = bench({ 0: [0x08, 0x44, 0x44] });
    b.cpu.en = 2;
    run(b.cpu, 1);                                       // LBI
    b.io.inp = 0xD;
    run(b.cpu, 1);                                       // deferred: NOP runs
    expect(b.cpu.pc).toBe(2);
    run(b.cpu, 1);
    expect(b.cpu.pc).toBe(0x0FF);
  });

  it('a skip pending at the interrupt is honoured after the RET', () => {
    const { cpu, io } = bench({ 0: [0x51, 0x22, 0x32], 0xFF: [0x48] });
    cpu.a = 0xF;
    run(cpu, 1);                                         // AISC 1 -> skip pending
    expect(cpu.skip).toBe(true);
    cpu.en = 2;
    io.inp = 0xD;
    run(cpu, 1);                                         // interrupt taken
    expect(cpu.pc).toBe(0x0FF);
    expect(cpu.sa).toBe(1);
    run(cpu, 1);                                         // RET
    expect(cpu.pc).toBe(1);
    run(cpu, 1);                                         // SC is still skipped
    expect(cpu.c).toBe(0);
    expect(cpu.pc).toBe(2);
  });

  it('IN edges set their input latches; INIL reads and clears IL3 and IL0', () => {
    const { cpu, io } = bench({ 0: [0x44, 0x33, 0x29] });
    io.inp = 0x6;                                        // IN3 and IN0 fall
    run(cpu, 1);
    expect(cpu.il & 0x9).toBe(0x9);
    run(cpu, 1);                                         // INIL
    expect(cpu.a & 0x9).toBe(0x9);
    expect(cpu.il & 0x9).toBe(0);
  });
});

describe('COP420 — ports', () => {
  it('ING, ININ and INL read the pins', () => {
    const { cpu, io } = bench({ 0: [0x33, 0x2A, 0x33, 0x28, 0x33, 0x2E] });
    io.g = 0x6; io.inp = 0xB; io.l = 0xC3;
    run(cpu, 1); expect(cpu.a).toBe(0x6);
    run(cpu, 1); expect(cpu.a).toBe(0xB);
    cpu.b = 0x07;
    run(cpu, 1);
    expect(cpu.a).toBe(0x3);
    expect(cpu.ram[0x07]).toBe(0xC);
  });

  it('OMG, OGI and OBD drive G and D', () => {
    const { cpu, io } = bench({ 0: [0x33, 0x3A, 0x33, 0x5A, 0x33, 0x3E] });
    cpu.ram[0] = 0x9;
    run(cpu, 1); expect(cpu.g).toBe(9);
    run(cpu, 1); expect(cpu.g).toBe(0xA);
    cpu.b = 0x1D;
    run(cpu, 1); expect(cpu.d).toBe(0xD);
    expect(io.gw.slice(1)).toEqual([9, 0xA]);
    expect(io.dw.slice(1)).toEqual([0xD]);
  });

  it('SKGBZ n and SKGZ test the G pins', () => {
    const { cpu, io } = bench({ 0: [0x33, 0x11, 0x33, 0x01, 0x33, 0x21] });
    io.g = 0b0101;
    run(cpu, 1); expect(cpu.skip).toBe(true);            // bit 1 is zero
    cpu.skip = false;
    run(cpu, 1); expect(cpu.skip).toBe(false);           // bit 0 is one
    io.g = 0;
    run(cpu, 1); expect(cpu.skip).toBe(true);            // SKGZ
  });

  it('CAMQ builds Q = A:M and CQMA splits it into M and A; L follows Q only with EN2', () => {
    // The NewBrain's COP sends its interrupt byte as CAMQ with the type in A
    // and the data in M, and the Z80 reads the type from the top nibble; and it
    // gets its key codes back out through CQMA (M = high nibble, A = low).
    const { cpu, io } = bench({ 0: [0x33, 0x64, 0x33, 0x3C, 0x33, 0x2C] });
    cpu.ram[0] = 0x6; cpu.a = 0x9;
    run(cpu, 1);                                         // LEI 4: EN2 on, L drives Q (still 0)
    expect(io.lw).toEqual([0]);
    run(cpu, 1);                                         // CAMQ
    expect(cpu.q).toBe(0x96);
    expect(io.lw).toEqual([0, 0x96]);
    cpu.ram[0] = 0; cpu.a = 0;
    run(cpu, 1);                                         // CQMA
    expect([cpu.ram[0], cpu.a]).toEqual([0x9, 0x6]);
  });
});

describe('COP420 — host bus (MICROBUS)', () => {
  it('a host write clears G0 and loads Q, without driving L', () => {
    const { cpu, io } = bench();
    cpu.g = 0xF;
    cpu.en = 4;
    cpu.hostWrite(0xA5);
    expect(cpu.g).toBe(0xE);
    expect(io.gw.at(-1)).toBe(0xE);
    expect(cpu.q).toBe(0xA5);
    expect(io.lw).toEqual([]);
  });

  it('a host write with G0 already clear does not touch the pin', () => {
    const { cpu, io } = bench();
    cpu.hostWrite(0x11);
    expect(io.gw).toEqual([0]);                          // only the reset drive
  });

  it('a host read returns Q and changes nothing', () => {
    const { cpu } = bench();
    cpu.q = 0x3C; cpu.g = 0xF;
    expect(cpu.hostRead()).toBe(0x3C);
    expect(cpu.hostRead()).toBe(0x3C);
    expect(cpu.g).toBe(0xF);
  });

  it('the byte the host wrote is what CQMA gives the program', () => {
    const { cpu } = bench({ 0: [0x33, 0x2C] });
    cpu.hostWrite(0xA5);
    run(cpu, 1);
    expect([cpu.ram[0], cpu.a]).toEqual([0xA, 0x5]);
  });
});

describe('COP420 — serial I/O', () => {
  it('shift mode: bit 3 leaves on SO, one bit per cycle, SK pulses while SKL is set', () => {
    const { cpu, io } = bench();
    cpu.en = 8;                                          // EN3: SO enabled, EN0 = 0: shift
    cpu.sio = 0b1010;
    run(cpu, 4);
    expect(io.so).toEqual([1, 0, 1, 0]);
    expect(io.sk).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);     // SKL is set at reset
    expect(cpu.sio).toBe(0);
  });

  it('shift mode: SI enters at bit 0', () => {
    const { cpu, io } = bench();
    io.si = 1;
    run(cpu, 2);
    expect(cpu.sio).toBe(0b0011);
    run(cpu, 2);
    expect(cpu.sio).toBe(0b1111);
  });

  it('SO is held low in shift mode when EN3 is clear', () => {
    const { cpu, io } = bench();
    cpu.sio = 0xF;
    run(cpu, 3);
    expect(io.so).toEqual([]);                           // never left 0
  });

  it('XAS exchanges A with SIO and copies C into SKL', () => {
    const { cpu, io } = bench({ 0: [0x4F] });
    cpu.a = 0xA; cpu.sio = 0x5; cpu.c = 0;
    run(cpu, 1);
    expect(cpu.a).toBe(0x5);
    expect(cpu.skl).toBe(0);
    expect(cpu.sio).toBe(0b0100);                        // 1010 then this cycle's shift, SI = 0
    expect(io.sk).toEqual([]);                           // SKL clear: no SK clock
  });

  it('XAS with C set starts the SK clock', () => {
    const { cpu, io } = bench({ 0: [0x4F] });
    cpu.c = 1; cpu.skl = 0;
    run(cpu, 1);
    expect(cpu.skl).toBe(1);
    expect(io.sk).toEqual([1, 0]);
  });

  it('counter mode: SIO counts SI falling edges downward, wrapping 0 -> 15', () => {
    const { cpu, io } = bench();
    cpu.en = 1; cpu.sio = 1;
    io.si = 1; run(cpu, 1);
    expect(cpu.sio).toBe(1);                             // a rising edge counts nothing
    io.si = 0; run(cpu, 1);
    expect(cpu.sio).toBe(0);
    io.si = 1; run(cpu, 1);
    io.si = 0; run(cpu, 1);
    expect(cpu.sio).toBe(0xF);
    run(cpu, 3);
    expect(cpu.sio).toBe(0xF);                           // a held level counts nothing
  });

  it('counter mode: SO follows EN3 and SK follows SKL', () => {
    const { cpu, io } = bench();
    cpu.en = 1 | 8; cpu.skl = 0;
    run(cpu, 1);
    expect(io.so).toEqual([1]);
    expect(io.sk).toEqual([]);
    cpu.skl = 1;
    run(cpu, 2);
    expect(io.sk).toEqual([1]);                          // level, not a pulse train
  });
});

describe('COP420 — save / load', () => {
  function sink() {
    const items: Array<number | boolean | string | number[]> = [];
    const w = {
      u8: (v: number) => { items.push(v); }, u16: (v: number) => { items.push(v); },
      u32: (v: number) => { items.push(v); }, i32: (v: number) => { items.push(v); },
      f64: (v: number) => { items.push(v); }, bool: (v: boolean) => { items.push(v); },
      raw: (b: ArrayLike<number>) => { items.push(Array.from(b)); },
      bytes: (b: Uint8Array) => { items.push(Array.from(b)); },
      str: (s: string) => { items.push(s); },
    };
    let i = 0;
    const r = {
      u8: () => items[i++] as number, u16: () => items[i++] as number,
      u32: () => items[i++] as number, i32: () => items[i++] as number,
      f64: () => items[i++] as number, bool: () => items[i++] as boolean,
      rawInto: (dst: Uint8Array) => { dst.set(items[i++] as number[]); },
      bytes: () => Uint8Array.from(items[i++] as number[]),
      str: () => items[i++] as string,
    };
    return { w, r };
  }

  it('round-trips the whole machine state', () => {
    const prog = { 0: [0x51, 0x04, 0x08, 0x19, 0x4F, 0x69, 0x40, 0x44, 0x44, 0x44] };
    const a = bench(prog);
    a.cpu.a = 0xF; a.cpu.en = 8; a.cpu.q = 0x5A; a.cpu.il = 5; a.cpu.ram[9] = 3;
    run(a.cpu, 6);
    const { w, r } = sink();
    a.cpu.saveState(w);

    const b = bench(prog);
    b.cpu.loadState(r);
    for (const k of ['pc', 'a', 'b', 'c', 'g', 'd', 'en', 'q', 'sa', 'sb', 'sc', 'sio', 'skl', 't', 'skt', 'il', 'skip'] as const) {
      expect(b.cpu[k], k).toEqual(a.cpu[k]);
    }
    expect(Array.from(b.cpu.ram)).toEqual(Array.from(a.cpu.ram));

    // And they stay in step afterwards.
    for (let i = 0; i < 20; i++) {
      expect(b.cpu.step()).toBe(a.cpu.step());
      expect(b.cpu.pc).toBe(a.cpu.pc);
      expect(b.cpu.sio).toBe(a.cpu.sio);
    }
  });
});

describe('COP420 — disassembler', () => {
  function dis(bytes: number[], addr = 0) {
    const rom = new Uint8Array(1024);
    rom.set(bytes, addr);
    return cop420Disassemble(rom, addr);
  }

  it('decodes the one-byte forms', () => {
    expect(dis([0xD0], 0x45).text).toBe('JP 050');
    expect(dis([0x85]).text).toBe('JSRP 085');
    expect(dis([0xBF]).text).toBe('LQID');
    expect(dis([0xFF]).text).toBe('JID');
    expect(dis([0x7C]).text).toBe('STII 12');
    expect(dis([0x57]).text).toBe('AISC 7');
    expect(dis([0x0F]).text).toBe('LBI 0,0');
    expect(dis([0x19]).text).toBe('LBI 1,10');
    expect(dis([0x35]).text).toBe('LD 3');
  });

  it('decodes the two-byte forms', () => {
    const j = dis([0x6A, 0xE9]);
    expect([j.text, j.length]).toEqual(['JSR 2E9', 2]);
    expect(dis([0x33, 0x3E]).text).toBe('OBD');
    expect(dis([0x33, 0x68]).text).toBe('LEI 8');
    expect(dis([0x33, 0x9A]).text).toBe('LBI 1,10');
    expect(dis([0x23, 0xA3]).text).toBe('XAD 2,3');
  });

  it('flags the unassigned codes', () => {
    expect(dis([0x65]).illegal).toBe(true);
    expect(dis([0x33, 0x00]).illegal).toBe(true);
    expect(dis([0x23, 0x40]).illegal).toBe(true);
  });
});
