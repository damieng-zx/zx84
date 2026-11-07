/**
 * The Lynx's sound DAC, BREAK key and 6845 status port, against Camputers'
 * own circuit diagrams (the 128K motherboard, sheet 5 "Input/Output", and the
 * keyboard circuit diagram):
 *
 * - Port 0x84 latches D0-D5 into a 40174 whose outputs drive a binary-weighted
 *   ladder: D5 75K, D4 150K, D3 300K, D2 620K, D1 1.2M, D0 2.4M. A code's
 *   level is the sum of its bits' conductances over all six (worked by hand
 *   below, in 1/kilohm: 1/75 + 1/150 + 1/300 + 1/620 + 1/1200 + 1/2400
 *   = 0.0261962).
 * - BREAK is a push-button from keyboard-connector pin 6 to 0V, and that pin
 *   is the Z80's /INT line: held down, it requests an interrupt at every
 *   instruction boundary until it is let go.
 * - The CRTC is a plain 6845, which has no status register, so a read of the
 *   address port (0x86) is not driven.
 */

import { describe, it, expect, vi } from 'vitest';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';

/** Full scale's conductance, 1/kilohm (see the header). */
const FULL = 1 / 75 + 1 / 150 + 1 / 300 + 1 / 620 + 1 / 1200 + 1 / 2400;

/** A 6845 table in every test ROM, for the programs that load it: the PAL
 *  frame (as lynx-beam), 39 rows of 8 lines with VSYNC from row 35 — one
 *  VSYNC, so one frame interrupt, a frame. */
const CRTC = [4, 38, 9, 7, 5, 0, 6, 32, 7, 35, 3, 0x20, 1, 32];
const CRTC_TABLE = 0x0050;

function boot(code: number[], isr: number[] = []): LynxMachine {
  const m = new LynxMachine('lynx48', null);
  const rom = new Uint8Array(0x4000);
  rom.set(code, 0);
  rom.set(isr, 0x0038);
  rom.set(CRTC, CRTC_TABLE);
  m.loadROM(rom);
  m.reset();
  return m;
}

/** The level the mixer was last handed over one frame. */
function lastLevel(m: LynxMachine): number {
  const spy = vi.spyOn(m.mixer, 'accumulateLevel');
  m.tick();
  expect(spy).toHaveBeenCalled();
  return spy.mock.calls[spy.mock.calls.length - 1][0];
}

/** Write `value` to the DAC, then spin. */
const outDac = (value: number) => [
  0x3E, value,        // LD A,value
  0xD3, 0x84,         // OUT (84h),A
  0x18, 0xFE,         // JR $
];

describe('Lynx sound DAC', () => {
  it('drives the speaker at full scale for code 0x3F', () => {
    expect(lastLevel(boot(outDac(0x3f)))).toBeCloseTo(1, 9);
  });

  it('weights D5 alone at 75K against the ladder: 0.509 of full scale', () => {
    // (1/75) / 0.0261962 = 0.50898 — a hair over half, since the ladder's
    // 620K for D2 is light of the 600K a perfect binary ladder would have.
    expect(lastLevel(boot(outDac(0x20)))).toBeCloseTo((1 / 75) / FULL, 6);
    expect(lastLevel(boot(outDac(0x20)))).toBeCloseTo(0.50898, 4);
  });

  it('sums a mixed code, D4+D2+D0 = 0x15, to 0.332 of full scale', () => {
    // (1/150 + 1/620 + 1/2400) / 0.0261962 = 0.0086963 / 0.0261962 = 0.33197
    expect(lastLevel(boot(outDac(0x15)))).toBeCloseTo(0.33197, 4);
  });

  it('ignores D6 and D7, which the latch does not take', () => {
    expect(lastLevel(boot(outDac(0xc0)))).toBe(0);
    expect(lastLevel(boot(outDac(0xc1)))).toBeCloseTo((1 / 2400) / FULL, 9);
  });

  it('rises with every code: each bit outweighs all the bits below it', () => {
    let previous = -1;
    for (let code = 0; code < 64; code++) {
      const level = lastLevel(boot(outDac(code)));
      expect(level, `code ${code}`).toBeGreaterThan(previous);
      previous = level;
    }
  });

  it('starts silent: /RESET clears the latch', () => {
    const m = boot(outDac(0x3f));
    m.tick();
    m.reset();
    expect(m.dacLevel).toBe(0);
  });
});

/** The ISR's 16-bit entry count. */
const COUNT = 0x9000;

/** Program the 6845, then IM 1 with interrupts on (or off), spinning. */
function interruptProgram(enable: boolean): LynxMachine {
  const m = boot([
    0xF3,                   // 0000 DI
    0x31, 0x00, 0xC0,       // 0001 LD SP,C000h
    0xED, 0x56,             // 0004 IM 1
    0x21, CRTC_TABLE, 0x00, // 0006 LD HL,CRTC_TABLE
    0x06, CRTC.length / 2,  // 0009 LD B,pairs
    0x7E, 0xD3, 0x86,       // 000B LD A,(HL); OUT (86h),A
    0x23, 0x7E, 0xD3, 0x87, // 000E INC HL; LD A,(HL); OUT (87h),A
    0x23, 0x10, 0xF6,       // 0012 INC HL; DJNZ 000Bh
    enable ? 0xFB : 0xF3,   // 0015 EI / DI
    0x18, 0xFE,             // 0016 JR $
  ], [
    0xE5,                   // PUSH HL
    0x2A, COUNT & 0xFF, COUNT >> 8,   // LD HL,(COUNT)
    0x23,                   // INC HL
    0x22, COUNT & 0xFF, COUNT >> 8,   // LD (COUNT),HL
    0xE1,                   // POP HL
    0xFB,                   // EI
    0xC9,                   // RET
  ]);
  return m;
}

const entries = (m: LynxMachine) => m.memory.readByte(COUNT) | (m.memory.readByte(COUNT + 1) << 8);

describe('Lynx BREAK key', () => {
  it('interrupts once a frame with BREAK up', () => {
    const m = interruptProgram(true);
    for (let f = 0; f < 4; f++) m.tick();
    expect(entries(m)).toBe(4);
  });

  it('holds /INT low while down, so the ISR is re-entered as soon as it returns', () => {
    const m = interruptProgram(true);
    m.keyboard.setBreak(true);
    m.tick();
    // 80,000 T in the frame and 86 T an entry (13 T acknowledge plus the
    // 73 T handler): about 930 — far more than one, and no more than fits.
    const n = entries(m);
    expect(n).toBeGreaterThan(800);
    expect(n).toBeLessThanOrEqual(Math.ceil(80_000 / 86));
  });

  it('is a level, not a latched request: letting go stops it', () => {
    const m = interruptProgram(true);
    m.keyboard.setBreak(true);
    m.tick();
    m.keyboard.setBreak(false);
    const before = entries(m);
    m.tick();
    expect(entries(m) - before).toBe(1);   // just the frame interrupt
  });

  it('is masked like any maskable interrupt: DI ignores it', () => {
    const m = interruptProgram(false);
    m.keyboard.setBreak(true);
    for (let f = 0; f < 3; f++) m.tick();
    expect(entries(m)).toBe(0);
  });

  it('is the host Pause key, and a key release-all lets it go', () => {
    const m = interruptProgram(true);
    expect(m.services.input.keyDown({ code: 'Pause', key: 'Pause', shift: false, ctrl: false, alt: false })).toBe(true);
    expect(m.keyboard.breakDown).toBe(true);
    // Not a sense bit: every keyboard line still reads idle.
    for (let line = 0; line < 10; line++) expect(m.keyboard.read(line)).toBe(0xff);
    m.services.input.releaseAll();
    expect(m.keyboard.breakDown).toBe(false);
  });
});

describe('Lynx 6845 ports', () => {
  it('leaves the address port undriven on a read: a 6845 has no status register', () => {
    const m = boot([0x18, 0xFE]);
    expect(m.cpu.portIn(0x0086)).toBe(0xff);
    m.cpu.portOut(0x0086, 14);
    m.cpu.portOut(0x0087, 0x12);
    expect(m.cpu.portIn(0x0086)).toBe(0xff);
    // The cursor register R14 does read back through the data port.
    expect(m.cpu.portIn(0x0087)).toBe(0x12);
  });
});
