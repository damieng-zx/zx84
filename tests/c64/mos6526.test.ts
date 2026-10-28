/**
 * MOS 6526 CIA — timers, interrupts and time of day, against the data sheet:
 * a running timer underflows every latch + 1 clocks and reloads from its
 * latch; one-shot mode stops it at its first underflow; writing a stopped
 * timer's high byte loads the counter; reading the interrupt control register
 * reports the flags (bit 7 when /IRQ is asserted) and clears them; the time
 * of day counts BCD tenths, seconds, minutes and 1-12 hours with an AM/PM
 * flag, and reading the hours freezes what the registers show until the
 * tenths are read.
 */

import { describe, it, expect } from 'vitest';
import { Mos6526, CIA_INT_TA, CIA_INT_TB, CIA_INT_FLAG } from '@/cores/mos6526.ts';

function timerA(latch: number, control: number): Mos6526 {
  const cia = new Mos6526();
  cia.reset();
  cia.write(0x4, latch & 0xFF);
  cia.write(0x5, latch >> 8);
  cia.write(0xE, control);
  return cia;
}

describe('6526 interval timers', () => {
  it('underflows every latch + 1 clocks and reloads', () => {
    const cia = timerA(9, 0x11);              // START | LOAD, continuous
    cia.advanceTo(9);
    expect(cia.icrFlags & CIA_INT_TA, 'not yet: the counter has only reached 0').toBe(0);
    expect(cia.read(0x4)).toBe(0);
    cia.advanceTo(10);
    expect(cia.icrFlags & CIA_INT_TA).toBe(CIA_INT_TA);
    expect(cia.read(0x4), 'reloaded from the latch').toBe(9);
    cia.advanceTo(25);                         // underflows at 10 and 20, then 5 more clocks
    expect(cia.read(0x4)).toBe(4);
  });

  it('stops at the first underflow in one-shot mode', () => {
    const cia = timerA(4, 0x19);              // START | ONESHOT | LOAD
    cia.advanceTo(100);
    expect(cia.read(0xE) & 1, 'START cleared').toBe(0);
    expect(cia.read(0x4)).toBe(4);
    expect(cia.read(0xD) & CIA_INT_TA).toBe(CIA_INT_TA);
    expect(cia.read(0xD), 'one underflow only').toBe(0);
  });

  it('loads the counter on a high-byte write only while stopped', () => {
    const cia = new Mos6526();
    cia.reset();
    cia.write(0x4, 0x34);
    cia.write(0x5, 0x12);
    expect(cia.read(0x4) | (cia.read(0x5) << 8)).toBe(0x1234);
    cia.write(0xE, 0x01);
    cia.advanceTo(0x10);
    cia.write(0x5, 0x55);
    expect(cia.read(0x5), 'a running timer keeps counting from where it was').toBe(0x12);
  });

  it('counts timer A underflows on timer B', () => {
    const cia = timerA(1, 0x11);              // A underflows every 2 clocks
    cia.write(0x6, 2);
    cia.write(0x7, 0);
    cia.write(0xF, 0x51);                      // START | LOAD | count TA underflows
    cia.advanceTo(5);                          // A underflows at 2 and 4
    expect(cia.read(0x6)).toBe(0);
    cia.advanceTo(6);                          // the third: B underflows
    expect(cia.icrFlags & CIA_INT_TB).toBe(CIA_INT_TB);
    expect(cia.read(0x6)).toBe(2);
  });
});

describe('6526 interrupt control', () => {
  it('asserts /IRQ only for enabled sources and clears on read', () => {
    const cia = timerA(0, 0x11);
    cia.advanceTo(3);
    expect(cia.irq, 'TA not enabled').toBe(false);
    cia.write(0xD, 0x81);                      // set mask bit 0
    expect(cia.irq, 'enabling a source already flagged asserts /IRQ').toBe(true);
    expect(cia.read(0xD)).toBe(0x81);
    expect(cia.irq).toBe(false);
    expect(cia.read(0xD)).toBe(0);
  });

  it('clears mask bits with bit 7 low', () => {
    const cia = new Mos6526();
    cia.reset();
    cia.write(0xD, 0x9F);
    cia.write(0xD, 0x01);
    expect(cia.icrMask).toBe(0x1E);
  });

  it('latches a FLAG edge', () => {
    const cia = new Mos6526();
    cia.reset();
    cia.write(0xD, 0x90);
    cia.flag();
    expect(cia.irq).toBe(true);
    expect(cia.read(0xD)).toBe(0x80 | CIA_INT_FLAG);
  });
});

describe('6526 time of day', () => {
  function clockAt(hr: number, min: number, sec: number, tenths: number): Mos6526 {
    const cia = new Mos6526();
    cia.reset();
    cia.write(0xE, 0x80);                      // 50 Hz input: five ticks a tenth
    cia.write(0xB, hr);
    cia.write(0xA, min);
    cia.write(0x9, sec);
    cia.write(0x8, tenths);                    // writing the tenths starts it
    return cia;
  }

  it('rolls 11:59:59.9 AM over to 12:00:00.0 PM', () => {
    const cia = clockAt(0x11, 0x59, 0x59, 9);
    for (let i = 0; i < 5; i++) cia.todTick();
    expect([cia.read(0xB), cia.read(0xA), cia.read(0x9), cia.read(0x8)]).toEqual([0x92, 0, 0, 0]);
  });

  it('rolls 12:59:59.9 over to 1:00:00.0 keeping AM/PM', () => {
    const cia = clockAt(0x92, 0x59, 0x59, 9);
    for (let i = 0; i < 5; i++) cia.todTick();
    expect(cia.read(0xB)).toBe(0x81);
    cia.read(0x8);
  });

  it('freezes the registers from an hours read until a tenths read', () => {
    const cia = clockAt(0x01, 0x00, 0x00, 0);
    expect(cia.read(0xB)).toBe(0x01);
    for (let i = 0; i < 50; i++) cia.todTick();   // a second passes
    expect(cia.read(0x9), 'still the latched second').toBe(0);
    expect(cia.read(0x8)).toBe(0);
    expect(cia.read(0x9), 'released').toBe(1);
  });

  it('stops while the hours have been written but not the tenths', () => {
    const cia = clockAt(0x01, 0x00, 0x00, 0);
    cia.write(0xB, 0x02);
    for (let i = 0; i < 50; i++) cia.todTick();
    expect(cia.read(0x9)).toBe(0);
    cia.read(0x8);
  });
});
