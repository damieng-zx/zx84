/**
 * R-register increment behaviour for prefixed instructions.
 *
 * Spec (comp.sys.sinclair FAQ, "The R Register"): R counts M1 cycles.
 * DD/FD/ED/CB prefixes are fetched as their own M1 cycles, so shifted
 * instructions increase R by two — and doubly-shifted DD CB / FD CB
 * opcodes *also* increase R by only two, even though their fourth
 * (opcode) byte is a third fetch: that fetch is not a counted M1.
 *
 * The FAQ's worked example pins the semantics of LD A,R too: after a
 * reset, DI, LD A,R leaves A = 0x03 (R counts the DI, the ED fetch, and
 * the 5F fetch, and LD A,R reads the post-increment value).
 *
 * These tests exist because a code review once flagged executeDDCB() as
 * "missing" the R increment for the CB byte. It is not missing: the CB
 * prefix byte is fetched (with its M1 R increment) by executeDD()/
 * executeFD() before dispatch, exactly as executeCB() fetches the byte
 * after a plain CB.
 */

import { describe, it, expect } from 'vitest';
import { newCpu, load, step } from './_harness.ts';

describe('R register — M1 counting', () => {
  it('NOP: R += 1 (single M1)', () => {
    const h = newCpu();
    load(h.mem, 0, 0x00);
    h.cpu.r = 0;
    step(h);
    expect(h.cpu.r & 0x7F).toBe(1);
  });

  it('CB 00 (RLC B): R += 2 (CB M1 + opcode M1)', () => {
    const h = newCpu();
    load(h.mem, 0, 0xCB, 0x00);
    h.cpu.r = 0;
    step(h);
    expect(h.cpu.r & 0x7F).toBe(2);
  });

  it('ED 00 (undocumented NOP): R += 2 (ED M1 + opcode M1)', () => {
    const h = newCpu();
    load(h.mem, 0, 0xED, 0x00);
    h.cpu.r = 0;
    step(h);
    expect(h.cpu.r & 0x7F).toBe(2);
  });

  it('DD 21 (LD IX,nn): R += 2 (DD M1 + opcode M1)', () => {
    const h = newCpu();
    load(h.mem, 0, 0xDD, 0x21, 0x00, 0x00);
    h.cpu.r = 0;
    step(h);
    expect(h.cpu.r & 0x7F).toBe(2);
  });

  it('redundant DD chain: each prefix is its own M1 (DD DD 21 → R += 3)', () => {
    const h = newCpu();
    load(h.mem, 0, 0xDD, 0xDD, 0x21, 0x00, 0x00);
    h.cpu.r = 0;
    step(h);
    expect(h.cpu.r & 0x7F).toBe(3);
  });

  it('DD CB 00 06 (RLC (IX+0)): doubly-shifted → still R += 2, not 3', () => {
    // The fourth byte (the CB opcode) is fetched by a non-M1 cycle: the
    // FAQ's "interesting exception" — DD CB adds only 2 to R.
    const h = newCpu();
    load(h.mem, 0, 0xDD, 0xCB, 0x00, 0x06);
    h.cpu.r = 0;
    step(h);
    expect(h.cpu.r & 0x7F).toBe(2);
  });

  it('FD CB 00 46 (BIT 0,(IY+0)): doubly-shifted → still R += 2', () => {
    const h = newCpu();
    load(h.mem, 0, 0xFD, 0xCB, 0x00, 0x46);
    h.cpu.r = 0;
    step(h);
    expect(h.cpu.r & 0x7F).toBe(2);
  });

  it('LD A,R sees the post-increment value (reset/DI/LD A,R → A = 0x03)', () => {
    const h = newCpu(); // constructor resets R to 0
    load(h.mem, 0, 0xF3, 0xED, 0x5F); // DI ; LD A,R
    step(h, 2);
    expect(h.cpu.a).toBe(0x03);
    expect(h.cpu.r & 0x7F).toBe(3);
  });

  it('increment wraps within the low 7 bits, preserving bit 7', () => {
    const h = newCpu();
    load(h.mem, 0, 0x00);
    h.cpu.r = 0xFF;
    step(h);
    expect(h.cpu.r).toBe(0x80);
  });
});
