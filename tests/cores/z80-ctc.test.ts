import { describe, it, expect, beforeEach } from 'vitest';
import { Z80Ctc } from '@/cores/z80-ctc.ts';

// Control-word bits, per the Z80 CTC datasheet.
const CONTROL = 0x01;
const INT_ENABLE = 0x80;
const COUNTER_MODE = 0x40;
const PRESCALE_256 = 0x20;
const TC_FOLLOWS = 0x04;
const TIMER_TRIGGER = 0x08;
const RESET = 0x02;

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

describe('Z80 CTC time-constant reload', () => {
  it('lets a running channel finish its count before a new constant applies', () => {
    const ctc = new Z80Ctc();
    ctc.write(1, CONTROL | COUNTER_MODE | TC_FOLLOWS);
    ctc.write(1, 5);
    ctc.trigger(1);                           // 5 -> 4
    ctc.write(1, CONTROL | COUNTER_MODE | TC_FOLLOWS); // no reset: still running
    ctc.write(1, 20);
    expect(ctc.read(1)).toBe(4);              // current count undisturbed
    for (let i = 0; i < 4; i++) ctc.trigger(1); // 4 -> 0: reload
    expect(ctc.read(1)).toBe(20);             // new constant taken at zero
  });

  it('loads the constant immediately after a software reset', () => {
    const ctc = new Z80Ctc();
    ctc.write(1, CONTROL | COUNTER_MODE | TC_FOLLOWS);
    ctc.write(1, 5);
    ctc.trigger(1);
    ctc.write(1, CONTROL | COUNTER_MODE | RESET | TC_FOLLOWS);
    ctc.write(1, 9);
    expect(ctc.read(1)).toBe(9);
  });
});

describe('Z80 CTC timer trigger (bit 3)', () => {
  it('holds a triggered timer until a CLK/TRG edge, then times normally', () => {
    const ctc = new Z80Ctc();
    ctc.write(0, CONTROL | INT_ENABLE | TIMER_TRIGGER | TC_FOLLOWS); // /16
    ctc.write(0, 1);
    ctc.addCycles(64);
    expect(ctc.interruptPending).toBe(false); // not started yet
    ctc.trigger(0);                           // start edge
    ctc.addCycles(15);
    expect(ctc.interruptPending).toBe(false);
    ctc.addCycles(1);                         // 16 cycles -> zero count
    expect(ctc.interruptPending).toBe(true);
  });

  it('starts an untriggered timer on the time-constant load', () => {
    const ctc = new Z80Ctc();
    ctc.write(0, CONTROL | INT_ENABLE | TC_FOLLOWS);
    ctc.write(0, 1);
    ctc.addCycles(16);
    expect(ctc.interruptPending).toBe(true);
  });
});

describe('Z80 CTC bulk trigger edges', () => {
  it('counts a burst of edges exactly, reloading and interrupting at each zero', () => {
    const ctc = new Z80Ctc();
    let ints = 0;
    ctc.onInterrupt = () => { ints++; };
    ctc.write(1, CONTROL | COUNTER_MODE | INT_ENABLE | TC_FOLLOWS);
    ctc.write(1, 10);
    ctc.triggerEdges(1, 25);                  // zero at edges 10 and 20
    expect(ints).toBe(2);
    expect(ctc.read(1)).toBe(5);              // 10 - 5 remaining edges
  });
});

// Daisy-chain interrupt priority (Zilog Z80 CTC Technical Manual, "Interrupt
// Operation"; Z80 Family Interrupt Structure tutorial): channel 0 is highest.
// Acknowledge sets a channel's IUS latch; while it is set that channel and all
// lower-priority channels (and downstream devices, via IEO) are inhibited, but
// a higher-priority channel may still interrupt. RETI clears the highest-
// priority IUS latch only.
describe('Z80 CTC daisy chain (IUS / RETI)', () => {
  /** Arm channel `c` as a counter with time constant 1 so one trigger fires it. */
  function arm(ctc: Z80Ctc, c: number): void {
    ctc.write(c, CONTROL | COUNTER_MODE | INT_ENABLE | TC_FOLLOWS);
    ctc.write(c, 1);
  }
  let ctc: Z80Ctc;
  beforeEach(() => {
    ctc = new Z80Ctc();
    ctc.write(0, 0x10);   // vector base 0x10 -> ch0 0x10, ch1 0x12, ch2 0x14, ch3 0x16
    for (let c = 0; c < 4; c++) arm(ctc, c);
  });

  it('holds IEO low from acknowledge until RETI', () => {
    expect(ctc.ieo).toBe(true);
    ctc.trigger(2);
    expect(ctc.ieo).toBe(true);           // pending only: not yet under service
    ctc.acknowledge();
    expect(ctc.ieo).toBe(false);
    ctc.reti();
    expect(ctc.ieo).toBe(true);
  });

  it('blocks a lower-priority channel while a higher one is under service', () => {
    ctc.trigger(1);
    ctc.acknowledge();                    // ch1 under service
    ctc.trigger(3);                       // ch3 now pending
    // Even with interrupts re-enabled in the ISR, ch3 must not request.
    expect(ctc.interruptPending).toBe(false);
    expect(ctc.pendingVector()).toBe(-1);
    ctc.reti();
    expect(ctc.interruptPending).toBe(true);
    expect(ctc.pendingVector()).toBe(0x16);
  });

  it('blocks a channel from re-interrupting itself until RETI', () => {
    ctc.trigger(2);
    ctc.acknowledge();
    ctc.trigger(2);                       // fires again inside its own ISR
    expect(ctc.interruptPending).toBe(false);
    ctc.reti();
    expect(ctc.pendingVector()).toBe(0x14);
  });

  it('lets a higher-priority channel nest inside a lower one', () => {
    ctc.trigger(3);
    ctc.acknowledge();                    // ch3 under service
    ctc.trigger(0);
    expect(ctc.interruptPending).toBe(true);
    expect(ctc.pendingVector()).toBe(0x10);
    ctc.acknowledge();                    // ch0 now nested
    ctc.trigger(1);                       // ch1: below ch0 -> blocked
    expect(ctc.interruptPending).toBe(false);
    // First RETI ends the ch0 ISR only; ch3 is still under service, so ch1
    // (higher than ch3) may now request but IEO stays low.
    ctc.reti();
    expect(ctc.ieo).toBe(false);
    expect(ctc.pendingVector()).toBe(0x12);
    ctc.acknowledge();                    // ch1 nests inside ch3
    ctc.reti();                           // ends ch1
    expect(ctc.ieo).toBe(false);          // ch3 still under service
    ctc.reti();                           // ends ch3
    expect(ctc.ieo).toBe(true);
  });

  it('RETI clears the highest-priority channel under service, not the lowest', () => {
    ctc.trigger(3);
    ctc.acknowledge();                    // ch3 IUS
    ctc.trigger(1);
    ctc.acknowledge();                    // ch1 IUS (nested)
    ctc.reti();                           // must clear ch1, leaving ch3 in service
    ctc.trigger(2);                       // ch2 is above ch3 -> may request
    expect(ctc.pendingVector()).toBe(0x14);
    ctc.trigger(3);                       // ch3 still in service -> cannot request itself
    ctc.acknowledge();                    // take ch2
    ctc.reti();                           // clear ch2
    expect(ctc.interruptPending).toBe(false);   // ch3 pending but blocked by its own IUS
    ctc.reti();                           // clear ch3
    expect(ctc.pendingVector()).toBe(0x16);
  });

  it('reset clears the under-service latches', () => {
    ctc.trigger(0);
    ctc.acknowledge();
    ctc.reset();
    expect(ctc.ieo).toBe(true);
  });
});
