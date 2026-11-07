/**
 * Apple II game connector: the 558 paddle timers read through the monitor's
 * PREAD routine at $FB1E, proportional (gamepad) input, and the annunciator
 * latches at $C058-$C05F.
 *
 * Expected values from the Apple II Reference Manual: PDL/PREAD return 0-255,
 * 0 with the paddle (joystick X) fully anticlockwise / left and 255 fully
 * clockwise / right, joystick Y 0 at full up; PTRIG ($C070) starts all four
 * timers; PREAD counts passes of an 11-cycle loop. The annunciators are four
 * latched outputs, $C058/$C059 AN0 off/on up to $C05E/$C05F AN3.
 *
 * The routine at $FB1E is PREAD's documented algorithm assembled here (the
 * real monitor ROM is not redistributable): trigger, two NOPs, then sample
 * PADDL0+X every 11 cycles, counting in Y. When `mcp/.cache/apple2plus.rom`
 * is present the same checks also run against the real ROM's PREAD.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';

/** $D000: for X = 0..3 { JSR $FB1E; STY $0300,X }, then flag $0310 and spin.
 *  $FB1E: PREAD. */
function testRom(base?: Uint8Array): Uint8Array {
  const rom = base ? base.slice() : new Uint8Array(0x3000);
  rom.set([
    0xA2, 0x00,             // D000 LDX #0
    0x20, 0x1E, 0xFB,       // D002 JSR $FB1E
    0x98,                   // D005 TYA
    0x9D, 0x00, 0x03,       // D006 STA $0300,X
    0xE8,                   // D009 INX
    0xE0, 0x04,             // D00A CPX #4
    0xD0, 0xF4,             // D00C BNE $D002
    0xA9, 0x01,             // D00E LDA #1
    0x8D, 0x10, 0x03,       // D010 STA $0310
    0x4C, 0x13, 0xD0,       // D013 JMP $D013
  ], 0x0000);
  if (!base) {
    rom.set([
      0xAD, 0x70, 0xC0,     // FB1E LDA $C070   trigger the timers
      0xA0, 0x00,           //      LDY #0
      0xEA, 0xEA,           //      NOP, NOP
      0xBD, 0x64, 0xC0,     // FB25 LDA $C064,X timer still running?
      0x10, 0x04,           //      BPL done
      0xC8,                 //      INY
      0xD0, 0xF8,           //      BNE FB25
      0x88,                 //      DEY         (overflow: 255)
      0x60,                 // done RTS
    ], 0xFB1E - 0xD000);
  }
  rom[0x2FFC] = 0x00; rom[0x2FFD] = 0xD0;              // reset → $D000
  return rom;
}

/** Run the reader: the four PREAD results, paddles 0-3. */
function readPaddles(m: Apple2Machine): number[] {
  m.reset();
  for (let i = 0; i < 20 && m.memory.readByte(0x0310) !== 1; i++) m.tick();
  expect(m.memory.readByte(0x0310)).toBe(1);
  return [0, 1, 2, 3].map(i => m.memory.readByte(0x0300 + i));
}

function machine(rom?: () => Uint8Array): Apple2Machine {
  const m = new Apple2Machine('apple2-plus', null);
  m.loadROM(testRom(rom?.()));
  return m;
}

function gameportSuite(rom?: () => Uint8Array): void {
  it('reads full left / full up as 0 and full right / full down as 255', () => {
    const m = machine(rom);
    try {
      const joy = m.services.input.joystick!;
      joy.press('left', true, 'fixed', 0);
      joy.press('up', true, 'fixed', 0);
      joy.press('right', true, 'fixed', 1);
      joy.press('down', true, 'fixed', 1);
      expect(readPaddles(m)).toEqual([0, 0, 255, 255]);
    } finally { m.destroy(); }
  });

  it('a gamepad axis is proportional: -1 → 0, +0.5 → 191, +1 → 255', () => {
    const m = machine(rom);
    try {
      const joy = m.services.input.joystick!;
      joy.analog!('x', -1, 0);
      joy.analog!('y', 0.5, 0);            // (0.5 + 1) / 2 × 255 = 191.25
      joy.analog!('x', 1, 1);
      joy.analog!('y', -0.5, 1);           // 63.75
      expect(readPaddles(m)).toEqual([0, 191, 255, 64]);
    } finally { m.destroy(); }
  });

  it('a released stick reads centred (127)', () => {
    const m = machine(rom);
    try {
      expect(readPaddles(m)).toEqual([127, 127, 127, 127]);
    } finally { m.destroy(); }
  });
}

describe('Apple II PREAD (the documented algorithm)', () => gameportSuite());

const ROM = resolve(__dirname, '../mcp/.cache/apple2plus.rom');
describe.skipIf(!existsSync(ROM))('Apple II PREAD in the real Autostart ROM', () =>
  gameportSuite(() => new Uint8Array(readFileSync(ROM))));

describe('Apple II annunciators', () => {
  it('latch off on the even address and on on the odd one, by read or write', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      const an = m.paddles.annunciators;
      expect(an).toEqual([false, false, false, false]);
      m.memory.readByte(0xC059);                       // AN0 on
      m.memory.writeByte(0xC05D, 0);                   // AN2 on
      m.memory.readByte(0xC05F);                       // AN3 on
      expect(an).toEqual([true, false, true, true]);
      m.memory.readByte(0xC058);                       // AN0 off
      m.memory.readByte(0xC05B);                       // AN1 on
      expect(an).toEqual([false, true, true, true]);
      m.memory.readByte(0xC05E);                       // AN3 off
      expect(an[3]).toBe(false);
    } finally { m.destroy(); }
  });

  it('on the //e, AN3 is also the double hi-res switch', () => {
    const m = new Apple2Machine('apple2e', null);
    try {
      m.memory.readByte(0xC05E);
      expect(m.paddles.annunciators[3]).toBe(false);
      expect(m.dhires).toBe(true);
      m.memory.readByte(0xC05F);
      expect(m.paddles.annunciators[3]).toBe(true);
      expect(m.dhires).toBe(false);
      m.memory.readByte(0xC05A + 1);
      expect(m.paddles.annunciators[1]).toBe(true);
    } finally { m.destroy(); }
  });
});
