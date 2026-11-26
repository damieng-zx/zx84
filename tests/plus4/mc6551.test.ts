/**
 * The 6551A's character timing: a frame is a start bit, the data bits, parity
 * when enabled and the stop bits, at two CPU cycles per bit times the control
 * register's baud divisor.
 */

import { describe, it, expect } from 'vitest';
import { Mc6551 } from '@/cores/mc6551.ts';

const TDRE = 0x10;
const RDRF = 0x08;
const OVRN = 0x04;

function chip(control = 0, command = 0): Mc6551 {
  const a = new Mc6551();
  a.write(3, control);
  a.write(2, command);
  a.tick(0);
  return a;
}

describe('the 6551A transmitter', () => {
  it('holds TDRE clear for the frame and sets it at the last bit', () => {
    const a = chip();
    expect(a.peek(1) & TDRE, 'idle').toBe(TDRE);
    a.tick(1000);
    a.write(0, 0x41);
    expect(a.peek(1) & TDRE, 'shifting').toBe(0);
    a.tick(1319);                        // 10 bits x 2 cycles x divisor 16
    expect(a.peek(1) & TDRE, 'the bit before the end').toBe(0);
    a.tick(1320);
    expect(a.peek(1) & TDRE, 'the last bit').toBe(TDRE);
  });

  it('counts the stop and parity bits in the frame', () => {
    // Format 100 is 8 data bits, two stop bits: 11 bits, 352 cycles.
    const twoStop = chip(0x08);
    twoStop.tick(100);
    twoStop.write(0, 0x42);
    twoStop.tick(451);
    expect(twoStop.peek(1) & TDRE).toBe(0);
    twoStop.tick(452);
    expect(twoStop.peek(1) & TDRE).toBe(TDRE);
    // Parity enabled adds a bit: 11 bits, 352 cycles.
    const parity = chip(0x00, 0x20);
    parity.tick(100);
    parity.write(0, 0x43);
    parity.tick(451);
    expect(parity.peek(1) & TDRE).toBe(0);
    parity.tick(452);
    expect(parity.peek(1) & TDRE).toBe(TDRE);
  });

  it('raises the enabled transmit interrupt only when the shifter is free', () => {
    const a = chip(0, 0x02);
    expect(a.irq, 'idle, TDRE set').toBe(true);
    a.tick(10);
    a.write(0, 0x44);
    expect(a.irq, 'while a frame shifts').toBe(false);
    a.tick(10 + 320);
    expect(a.irq, 'when it has gone').toBe(true);
  });

  it('reports the byte and cycle it started on', () => {
    const a = chip();
    a.tick(500);
    const seen: [number, number][] = [];
    a.onTxByte = (value, start) => seen.push([value, start]);
    a.write(0, 0x55);
    expect(seen).toEqual([[0x55, 500]]);
  });
});

describe('the 6551A receiver', () => {
  it('makes a byte available when its frame has been clocked in', () => {
    const a = chip();
    a.tick(200);
    a.receive(0x5A);
    expect(a.peek(1) & RDRF, 'still arriving').toBe(0);
    a.tick(519);
    expect(a.peek(1) & RDRF).toBe(0);
    a.tick(520);
    expect(a.peek(1) & RDRF, 'arrived').toBe(RDRF);
    expect(a.read(0), 'the byte').toBe(0x5A);
    expect(a.peek(1) & RDRF, 'reading clears it').toBe(0);
  });

  it('flags an overrun when another byte starts into a full receiver', () => {
    const a = chip();
    a.tick(0);
    a.receive(0x11);
    a.receive(0x22);                     // the first is still arriving
    expect(a.peek(1) & OVRN, 'overrun').toBe(OVRN);
  });
});
