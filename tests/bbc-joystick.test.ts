/**
 * BBC Micro analogue port: the uPD7002 ADC at &FEC0-&FEDF, its end-of-
 * conversion line on System VIA CB1, and the fire buttons on System VIA
 * PB4/PB5.
 *
 * Expected values come from the uPD7002 data sheet and the BBC Micro Advanced
 * User Guide: write &FEC0 = b1-b0 channel, b2 flag, b3 1 for a 12-bit
 * conversion (10 ms) or 0 for 8-bit (4 ms); status b7 /EOC, b6 /BUSY, b5-b4
 * the top two result bits, b3-b0 echo the control nibble; &FEC1 = result
 * bits 11-4, &FEC2 = bits 3-0 in the top nibble. ADVAL(n) is that 12-bit
 * value times 16 (0-65520), highest at full left and full up; ADVAL(0)'s low
 * byte has bit 0 for joystick 1's fire button and bit 1 for joystick 2's.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { VIA_IFR_CB1 } from '@/cores/m6522.ts';

/** A ROM that just spins, so the hardware can be driven by hand. */
function spinning(): BbcMachine {
  const r = new Uint8Array(0x8000);
  r.set([0x4C, 0x00, 0xC0], 0);                    // $C000: JMP $C000
  r[0x7FFC] = 0x00; r[0x7FFD] = 0xC0;
  const m = new BbcMachine('bbc-b', null);
  m.loadROM(r);
  m.reset();
  return m;
}

describe('BBC uPD7002 ADC registers', () => {
  it('a 12-bit conversion is busy for 10 ms (20000 cycles) and then reports its result', () => {
    const m = spinning();
    m.adc.inputs[1] = 0xABC;
    m.adc.write(0, 0x0D, 1000);                      // channel 1, flag, 12-bit
    expect(m.adc.read(0)).toBe(0x8D);                // /EOC high, /BUSY low, nibble echoed
    m.adc.tick(1000 + 19_999);
    expect(m.adc.read(0) & 0xC0).toBe(0x80);         // still converting
    m.adc.tick(1000 + 20_000);
    // 0xABC = 1010 1011 1100: top two bits 10 → status b5-b4 = 10.
    expect(m.adc.read(0)).toBe(0x40 | 0x20 | 0x0D);
    expect(m.adc.read(1)).toBe(0xAB);
    expect(m.adc.read(2)).toBe(0xC0);
    expect(m.adc.read(3)).toBe(0xC0);
    m.destroy();
  });

  it('an 8-bit conversion takes 4 ms (8000 cycles) and has no low nibble', () => {
    const m = spinning();
    m.adc.inputs[2] = 0x5A7;
    m.adc.write(0, 0x02, 0);
    m.adc.tick(7_999);
    expect(m.adc.read(0) & 0x80).toBe(0x80);
    m.adc.tick(8_000);
    expect(m.adc.read(0) & 0xC0).toBe(0x40);
    expect(m.adc.read(1)).toBe(0x5A);
    expect(m.adc.read(2)).toBe(0x00);
    m.destroy();
  });

  it('only register 0 starts a conversion', () => {
    const m = spinning();
    m.adc.write(1, 0x0C, 0);
    m.adc.write(2, 0x0C, 0);
    expect(m.adc.read(0) & 0x80).toBe(0x00);
    expect(m.adc.doneAt).toBe(-1);
    m.destroy();
  });

  it('end of conversion is a falling edge on System VIA CB1 through the bus', () => {
    const m = spinning();
    m.memory.writeByte(0xFE4C, 0x00);                 // PCR: CB1 interrupts on a negative edge
    m.memory.writeByte(0xFE4D, 0x7F);                 // clear any flags
    m.memory.writeByte(0xFEC0, 0x08);                 // channel 0, 12-bit, via SHEILA
    expect(m.sysVia.read(0x0D) & VIA_IFR_CB1).toBe(0);
    m.runUntil(1);                                    // one 20 ms frame covers the 10 ms
    expect(m.sysVia.read(0x0D) & VIA_IFR_CB1).toBe(VIA_IFR_CB1);
    expect(m.memory.readByte(0xFEC0) & 0xC0).toBe(0x40);
    // The block repeats every four bytes up to &FEDF.
    expect(m.memory.readByte(0xFEDC)).toBe(m.memory.readByte(0xFEC0));
    m.destroy();
  });
});

describe('BBC joystick → ADC channels and fire buttons', () => {
  it('player 1 drives channels 0/1, player 2 channels 2/3, left and up at full scale', () => {
    const m = spinning();
    const joy = m.services.input.joystick!;
    expect(Array.from(m.adc.inputs)).toEqual([0x800, 0x800, 0x800, 0x800]);
    joy.press('left', true, 'kempston', 0);
    joy.press('down', true, 'kempston', 0);
    joy.press('right', true, 'kempston', 1);
    joy.press('up', true, 'kempston', 1);
    expect(Array.from(m.adc.inputs)).toEqual([0xFFF, 0x000, 0x000, 0xFFF]);
    joy.press('left', false, 'kempston', 0);
    expect(m.adc.inputs[0]).toBe(0x800);
    m.destroy();
  });

  it('a gamepad axis is proportional: halfway right is a quarter of full scale', () => {
    const m = spinning();
    const joy = m.services.input.joystick!;
    joy.analog!('x', 0.5, 0);
    joy.analog!('y', -1, 1);
    expect(m.adc.inputs[0]).toBe(Math.round(0.25 * 0xFFF));
    expect(m.adc.inputs[3]).toBe(0xFFF);
    m.destroy();
  });

  it('fire grounds PB4 (joystick 1) or PB5 (joystick 2) and nothing else', () => {
    const m = spinning();
    const joy = m.services.input.joystick!;
    m.memory.writeByte(0xFE42, 0x0F);                 // DDRB: PB0-3 outputs, PB4-7 inputs
    expect(m.memory.readByte(0xFE40) & 0xF0).toBe(0xF0);
    joy.press('fire', true, 'kempston', 0);
    expect(m.memory.readByte(0xFE40) & 0xF0).toBe(0xE0);
    joy.press('fire', true, 'kempston', 1);
    expect(m.memory.readByte(0xFE40) & 0xF0).toBe(0xC0);
    m.services.input.releaseAll();
    expect(m.memory.readByte(0xFE40) & 0xF0).toBe(0xF0);
    m.destroy();
  });
});

const CACHE = resolve(__dirname, '../mcp/.cache');
const haveRoms = ['bbc-os12.rom', 'bbc-basic2.rom'].every(r => existsSync(resolve(CACHE, r)));

describe.skipIf(!haveRoms)('BBC ADVAL through MOS 1.20 (OSBYTE 128)', () => {
  function boot(): BbcMachine {
    const rom = new Uint8Array(0x8000);
    rom.set(readFileSync(resolve(CACHE, 'bbc-os12.rom')), 0);
    rom.set(readFileSync(resolve(CACHE, 'bbc-basic2.rom')), 0x4000);
    const m = new BbcMachine('bbc-b', null);
    m.loadROM(rom);
    m.reset();
    for (let i = 0; i < 150; i++) m.tick();
    return m;
  }
  function type(m: BbcMachine, s: string): void {
    for (const ch of s) {
      const ev = {
        code: ch === '\n' ? 'Enter' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : '',
        key: ch === '\n' ? 'Enter' : ch, shift: false, ctrl: false, alt: false,
      };
      m.services.input.keyDown(ev);
      for (let i = 0; i < 3; i++) m.tick();
      m.services.input.keyUp(ev);
      for (let i = 0; i < 3; i++) m.tick();
    }
  }
  /** BASIC's resident integer variable (A% is at &404, B% at &408, …). */
  function intVar(m: BbcMachine, name: string): number {
    const a = 0x400 + 4 * (name.charCodeAt(0) - 0x40);
    const r = m.memory.ram;
    return (r[a] | (r[a + 1] << 8) | (r[a + 2] << 16) | (r[a + 3] << 24)) >>> 0;
  }

  it('reads full left, centre and full down, and joystick 1 fire, from the ADC', () => {
    const m = boot();
    const joy = m.services.input.joystick!;
    joy.press('left', true, 'kempston', 0);
    joy.press('fire', true, 'kempston', 0);
    joy.press('down', true, 'kempston', 1);
    // The MOS converts the four channels in turn, 10 ms each.
    for (let i = 0; i < 10; i++) m.tick();
    type(m, 'A%=ADVAL(1):B%=ADVAL(2):C%=ADVAL(4):D%=ADVAL(0) AND 255\n');
    for (let i = 0; i < 5; i++) m.tick();
    expect(intVar(m, 'A')).toBe(65520);              // 0xFFF << 4: full left
    expect(intVar(m, 'B')).toBe(0x800 << 4);         // joystick 1 Y untouched: centred
    expect(intVar(m, 'C')).toBe(0);                  // joystick 2 full down
    expect(intVar(m, 'D')).toBe(1);                  // fire on joystick 1 only
    m.destroy();
  }, 60_000);
});
