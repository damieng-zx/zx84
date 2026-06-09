/**
 * Z80 I/O cycle T-state placement tests.
 *
 * The core's convention (established by IN A,(n) for tape edge loaders):
 *   - INs sample the port LATE in the 4T IORQ cycle (3T in), because the
 *     real Z80 latches data at the end of the I/O cycle. A tape edge that
 *     falls inside the IORQ window must be classified at the sample point.
 *   - OUTs hit the port handler at the START of the I/O cycle, when the
 *     Z80 asserts the data bus.
 *
 * Expected values below are hard-coded from the hardware M-cycle breakdowns
 * (Sean Young, "The Undocumented Z80 Documented"), NOT from the emulator:
 *   IN A,(n)   11T = M1(4) + operand(3) + IO(4)         → sample T+10
 *   IN r,(C)   12T = M1(4) + M1(4) + IO(4)              → sample T+11
 *   INI        16T = M1(4) + M1(4) + int(1) + IO(4) + MW(3) → sample T+12
 *   OUT (n),A  11T = M1(4) + operand(3) + IO(4)         → out at T+7
 *   OUT (C),r  12T = M1(4) + M1(4) + IO(4)              → out at T+8
 *   OUTI       16T = M1(4) + M1(4) + int(1) + MR(3) + IO(4) → out at T+12
 *   OTIR       21T per repeat (16 + 5 internal at BC)
 */
import { describe, it, expect } from 'vitest';
import { newCpu, load, step, type Harness } from './_harness.ts';

function recordInSample(h: Harness, value = 0xFF): { t: number } {
  const rec = { t: -1 };
  h.cpu.portInHandler = () => { rec.t = h.cpu.tStates; return value; };
  return rec;
}

function recordOutSample(h: Harness): { t: number; val: number }[] {
  const rec: { t: number; val: number }[] = [];
  h.cpu.portOutHandler = (_port, val) => { rec.push({ t: h.cpu.tStates, val }); };
  return rec;
}

describe('Z80 — IN sample point (late in the IORQ cycle)', () => {
  it('IN A,(n) samples the port at T+10 of 11', () => {
    const h = newCpu();
    const sample = recordInSample(h);
    load(h.mem, 0, 0xDB, 0xFE); // IN A,($FE)
    step(h);
    expect(sample.t).toBe(10);
    expect(h.cpu.tStates).toBe(11);
  });

  it('IN A,(C) samples the port at T+11 of 12 (same convention as IN A,(n))', () => {
    const h = newCpu();
    const sample = recordInSample(h);
    h.cpu.bc = 0x10FE;
    load(h.mem, 0, 0xED, 0x78); // IN A,(C)
    step(h);
    expect(sample.t).toBe(11);
    expect(h.cpu.tStates).toBe(12);
  });

  it('INI samples the port at T+12 of 16 and writes (HL) at T+13', () => {
    const h = newCpu();
    const sample = recordInSample(h, 0x42);
    let writeT = -1;
    const origWrite = h.cpu.write8;
    h.cpu.write8 = (a, v) => { if (a === 0xC000) writeT = h.cpu.tStates; origWrite(a, v); };
    h.cpu.bc = 0x02FE;
    h.cpu.hl = 0xC000;
    load(h.mem, 0, 0xED, 0xA2); // INI
    step(h);
    expect(sample.t).toBe(12);
    expect(writeT).toBe(13);
    expect(h.cpu.tStates).toBe(16);
    expect(h.mem[0xC000]).toBe(0x42);
  });
});

describe('Z80 — OUT placement (start of the IORQ cycle)', () => {
  it('OUT (n),A hits the port at T+7 of 11', () => {
    const h = newCpu();
    const outs = recordOutSample(h);
    h.cpu.a = 0x12;
    load(h.mem, 0, 0xD3, 0xFE); // OUT ($FE),A
    step(h);
    expect(outs[0].t).toBe(7);
    expect(h.cpu.tStates).toBe(11);
  });

  it('OUT (C),r hits the port at T+8 of 12', () => {
    const h = newCpu();
    const outs = recordOutSample(h);
    h.cpu.bc = 0x10FE;
    load(h.mem, 0, 0xED, 0x41); // OUT (C),B
    step(h);
    expect(outs[0].t).toBe(8);
    expect(h.cpu.tStates).toBe(12);
  });

  it('OUTI hits the port at T+12 of 16 (after the (HL) read cycle)', () => {
    const h = newCpu();
    const outs = recordOutSample(h);
    h.cpu.bc = 0x02FE;
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x99;
    load(h.mem, 0, 0xED, 0xA3); // OUTI
    step(h);
    expect(outs[0].t).toBe(12);
    expect(outs[0].val).toBe(0x99);
    expect(h.cpu.tStates).toBe(16);
  });

  it('OTIR takes 21T per repeating iteration, 16T for the final one', () => {
    const h = newCpu();
    const outs = recordOutSample(h);
    h.cpu.bc = 0x02FE; // B=2: one repeat, one final
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x11;
    h.mem[0xC001] = 0x22;
    load(h.mem, 0, 0xED, 0xB3); // OTIR
    step(h); // first iteration: B 2→1, repeats
    expect(outs[0].t).toBe(12);
    expect(h.cpu.tStates).toBe(21);
    step(h); // second iteration: B 1→0, falls through
    expect(outs[1].t).toBe(21 + 12);
    expect(h.cpu.tStates).toBe(21 + 16);
  });
});
