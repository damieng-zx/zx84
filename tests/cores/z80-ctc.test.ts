import { describe, it, expect, beforeEach } from 'vitest';
import { Z80Ctc } from '@/cores/z80-ctc.ts';

// Control-word bits, per the Z80 CTC datasheet.
const CONTROL = 0x01;
const INT_ENABLE = 0x80;
const COUNTER_MODE = 0x40;
const PRESCALE_256 = 0x20;
const TC_FOLLOWS = 0x04;

describe('Z80 CTC counter mode', () => {
  let ctc: Z80Ctc;
  let ints: number;
  beforeEach(() => {
    ctc = new Z80Ctc();
    ints = 0;
    ctc.onInterrupt = () => { ints++; };
  });

  it('raises an interrupt after N external triggers, then reloads', () => {
    // Channel 1: counter mode, interrupts on, time constant follows.
    ctc.write(1, CONTROL | COUNTER_MODE | INT_ENABLE | TC_FOLLOWS);
    ctc.write(1, 2); // time constant = 2
    ctc.trigger(1);
    expect(ctc.interruptPending).toBe(false); // one pulse: 2 -> 1
    ctc.trigger(1);
    expect(ctc.interruptPending).toBe(true);  // second pulse: 1 -> 0 -> reload
    expect(ints).toBe(1);
    expect(ctc.read(1)).toBe(2);              // counter reloaded to the TC
  });

  it('does not count triggers on a channel in timer mode', () => {
    ctc.write(1, CONTROL | INT_ENABLE | TC_FOLLOWS); // timer mode (bit6 = 0)
    ctc.write(1, 2);
    ctc.trigger(1);
    ctc.trigger(1);
    expect(ctc.interruptPending).toBe(false);
  });
});

describe('Z80 CTC timer mode', () => {
  it('decrements once per prescaler window of CPU cycles', () => {
    const ctc = new Z80Ctc();
    // Timer mode, /256 prescaler, interrupts on, TC follows.
    ctc.write(2, CONTROL | INT_ENABLE | PRESCALE_256 | TC_FOLLOWS);
    ctc.write(2, 1); // time constant = 1 -> underflows every 256 cycles
    ctc.addCycles(255);
    expect(ctc.interruptPending).toBe(false);
    ctc.addCycles(1); // now 256 total -> one decrement -> underflow
    expect(ctc.interruptPending).toBe(true);
  });
});

describe('Z80 CTC interrupt vector', () => {
  it('composes the IM 2 vector from the base and channel number', () => {
    const ctc = new Z80Ctc();
    ctc.write(0, 0xF8);        // vector base (bit0 = 0 -> vector write on ch0)
    // Arm channel 2 in counter mode and drive it to terminal count.
    ctc.write(2, CONTROL | COUNTER_MODE | INT_ENABLE | TC_FOLLOWS);
    ctc.write(2, 1);
    ctc.trigger(2);
    expect(ctc.pendingVector()).toBe(0xF8 | (2 << 1)); // 0xFC
    ctc.acknowledge();
    expect(ctc.interruptPending).toBe(false);
  });
});
