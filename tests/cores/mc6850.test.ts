/**
 * MC6850 ACIA tests, against the Motorola datasheet: status bit assignments,
 * master reset, word formats, receiver flags, the DCD latch rule and
 * transmitter timing.
 */

import { describe, it, expect } from 'vitest';
import { Mc6850 } from '@/cores/mc6850.ts';

const RDRF = 0x01, TDRE = 0x02, DCD = 0x04, FE = 0x10, OVRN = 0x20, PE = 0x40, IRQ = 0x80;
const BIT = 100;

/** Line level for a frame sent at `start`: start bit, LSB-first data, optional parity, stop bit. */
function frameLevel(t: number, start: number, byte: number, parity: number | null = null, bits = 8): number {
  if (t < start) return 1;
  const i = Math.floor((t - start) / BIT);
  if (i === 0) return 0;
  if (i <= bits) return (byte >> (i - 1)) & 1;
  if (parity !== null && i === bits + 1) return parity;
  return 1;
}

function receive(a: Mc6850, levels: (t: number) => number, until: number): void {
  let last = 1, since = 0;
  for (let t = 0; t < until; t++) {
    const v = levels(t);
    if (v !== last) { last = v; since = t; }
    a.setRxLine(v, since);
    a.tick(t);
  }
}

// CR7 RIE | CR6:5 TX control | CR4:2 word select | CR1:0 divide. 0x15 = ÷16, 8N1.
function acia(control = 0x15): Mc6850 {
  const a = new Mc6850();
  a.rxBitCycles = BIT;
  a.txBitCycles = BIT;
  a.write(0, 0x03);                            // master reset
  a.write(0, control);
  return a;
}

describe('MC6850 status', () => {
  it('reports TDRE set and everything else clear after a master reset', () => {
    expect(acia().read(0)).toBe(TDRE);
  });

  it('latches a received byte in RDRF and clears it on reading the data register', () => {
    const a = acia();
    receive(a, t => frameLevel(t, 50, 0xA5), 50 + BIT * 10);
    expect(a.read(0) & RDRF).toBe(RDRF);
    expect(a.read(1)).toBe(0xA5);
    expect(a.read(0) & RDRF).toBe(0);
  });

  it('receives LSB first (0x01 is a 1 then seven 0s)', () => {
    const a = acia();
    receive(a, t => frameLevel(t, 50, 0x01), 50 + BIT * 10);
    expect(a.read(1)).toBe(0x01);
  });

  it('flags a framing error when the stop bit is low', () => {
    const a = acia();
    receive(a, t => t < 50 ? 1 : 0, 50 + BIT * 10 + 5);
    expect(a.read(0) & FE).toBe(FE);
  });

  it('sets overrun when a second byte arrives before the first is read', () => {
    const a = acia();
    receive(a, t => Math.min(frameLevel(t, 50, 0x11), frameLevel(t, 50 + BIT * 11, 0x22)), 50 + BIT * 22);
    expect(a.read(0) & OVRN).toBe(OVRN);
    expect(a.read(1)).toBe(0x11);                // the first byte is kept
  });

  it('checks even parity (word select 110 = 8E1)', () => {
    const good = acia(0x19);
    receive(good, t => frameLevel(t, 50, 0x07, 1), 50 + BIT * 11);   // three ones → parity bit 1
    expect(good.read(0) & PE).toBe(0);
    const bad = acia(0x19);
    receive(bad, t => frameLevel(t, 50, 0x07, 0), 50 + BIT * 11);
    expect(bad.read(0) & PE).toBe(PE);
  });

  it('rejects a start-bit glitch shorter than half a bit', () => {
    const a = acia();
    receive(a, t => (t >= 50 && t < 70) ? 0 : 1, 50 + BIT * 12);
    expect(a.read(0) & RDRF).toBe(0);
  });
});

describe('MC6850 interrupts', () => {
  it('asserts IRQ for received data only when RIE is set', () => {
    const off = acia(0x15);
    receive(off, t => frameLevel(t, 50, 0x42), 50 + BIT * 10);
    expect(off.irq).toBe(false);
    const on = acia(0x95);
    receive(on, t => frameLevel(t, 50, 0x42), 50 + BIT * 10);
    expect(on.irq).toBe(true);
    expect(on.read(0) & IRQ).toBe(IRQ);
    on.read(1);
    expect(on.irq).toBe(false);
  });

  it('asserts IRQ for an empty transmitter only with CR6:5 = 01', () => {
    expect(acia(0x15).irq).toBe(false);
    const a = acia(0x35);
    a.tick(0);
    expect(a.irq).toBe(true);
  });
});

describe('MC6850 DCD', () => {
  it('latches a rising carrier-detect edge until status+data are read with the pin low', () => {
    const a = acia(0x95);
    a.setDcd(true);
    expect(a.read(0) & DCD).toBe(DCD);
    expect(a.irq).toBe(true);
    a.setDcd(false);
    expect(a.read(0) & DCD).toBe(DCD);           // still latched
    a.read(1);                                    // status read then data read
    expect(a.read(0) & DCD).toBe(0);
  });

  it('keeps the latch while the pin is still high after the read sequence', () => {
    const a = acia();
    a.setDcd(true);
    a.read(0); a.read(1);
    expect(a.read(0) & DCD).toBe(DCD);
  });

  it('does not clear on a data read with no preceding status read', () => {
    const a = acia();
    a.setDcd(true); a.setDcd(false);
    a.read(1);
    expect(a.read(0) & DCD).toBe(DCD);
  });
});

describe('MC6850 transmitter', () => {
  it('takes a byte into the shifter one bit time after an idle write, keeping TDRE low until then', () => {
    const a = acia();
    const sent: [number, number][] = [];
    a.onTxByte = (v, at) => sent.push([v, at]);
    a.tick(1000);
    a.write(1, 0x5A);
    expect(a.read(0) & TDRE).toBe(0);
    a.tick(1000 + BIT - 1);
    expect(sent).toEqual([]);
    expect(a.read(0) & TDRE).toBe(0);
    a.tick(1000 + BIT);
    expect(sent).toEqual([[0x5A, 1000 + BIT]]);
    expect(a.read(0) & TDRE).toBe(TDRE);
  });

  it('starts a queued byte when the previous 10-bit frame ends, not before', () => {
    const a = acia();
    const sent: [number, number][] = [];
    a.onTxByte = (v, at) => sent.push([v, at]);
    a.tick(0); a.write(1, 1); a.tick(BIT);
    a.write(1, 2);                                 // holding register full
    a.tick(BIT + 500);
    expect(a.read(0) & TDRE).toBe(0);
    expect(sent.length).toBe(1);
    a.tick(BIT * 11 + 2);
    expect(sent).toEqual([[1, BIT], [2, BIT * 11]]);
  });

  it('uses 11 bit times for an 8E1 frame', () => {
    const a = acia(0x19);
    const sent: number[] = [];
    a.onTxByte = (_v, at) => sent.push(at);
    a.tick(0); a.write(1, 1); a.tick(BIT);
    a.write(1, 2); a.tick(BIT * 12 + 1);
    expect(sent).toEqual([BIT, BIT * 12]);
  });
});
