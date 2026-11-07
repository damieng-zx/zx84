/**
 * CPC Plus / GX4000 analogue joystick inputs: ASIC registers &6808-&680F.
 *
 * From CPCWiki "Analog Joysticks" (measured on a real Plus): &6808 ADC0 is
 * joystick 1 X (&00 = left, &3F = right), &6809 ADC1 joystick 1 Y (&00 = up,
 * &3F = down), &680A/&680B the same for joystick 2; ADC4 (&680C) and ADC6
 * (&680E) are tied to +5V and read &3F, ADC5 (&680D) and ADC7 (&680F) to
 * ground and read &00. Values are 6 bits, bits 7-6 read 0; a centred stick
 * reads about &1F-&20. The registers are read through the ASIC window after
 * unlocking and paging it in with RMR2.
 */

import { describe, it, expect } from 'vitest';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { Asic } from '@/machines/cpc/asic.ts';

const UNLOCK_BYTES = [
  0xFF, 0x00, 0xFF, 0x77, 0xB3, 0x51, 0xA8, 0xD4,
  0x62, 0x39, 0x9C, 0x46, 0x2B, 0x15, 0x8A, 0xCD,
];

/** A Plus with the ASIC unlocked and its register window at &4000-&7FFF. */
function paged(model: 'cpc6128plus' | 'gx4000' = 'cpc6128plus'): CpcMachine {
  const m = new CpcMachine(model, null);
  for (const b of UNLOCK_BYTES) m.cpu.portOut(0xBC00, b);
  m.cpu.portOut(0xBC00, 0xEE);
  m.cpu.portOut(0x7FB8, 0xB8);
  expect((m.gateArray as Asic).asicPageVisible).toBe(true);
  return m;
}

const channels = (m: CpcMachine): number[] =>
  Array.from({ length: 8 }, (_, i) => m.cpu.read8(0x6808 + i));

describe('CPC Plus analogue inputs', () => {
  it('reads a centred stick on ADC0-3 and the tied-off levels on ADC4-7', () => {
    const m = paged();
    expect(channels(m)).toEqual([0x20, 0x20, 0x20, 0x20, 0x3F, 0x00, 0x3F, 0x00]);
  });

  it('puts joystick 1 on &6808/&6809 and joystick 2 on &680A/&680B, left/up = 0', () => {
    const m = paged();
    const joy = m.services.input.joystick;
    joy.press('left', true, 'keys', 0);
    joy.press('down', true, 'keys', 0);
    joy.press('right', true, 'keys', 1);
    joy.press('up', true, 'keys', 1);
    expect(channels(m).slice(0, 4)).toEqual([0x00, 0x3F, 0x3F, 0x00]);
    joy.press('left', false, 'keys', 0);
    expect(m.cpu.read8(0x6808)).toBe(0x20);
  });

  it('a gamepad axis is proportional over 6 bits and also drives the digital port', () => {
    const m = paged('gx4000');
    const joy = m.services.input.joystick;
    joy.analog!('x', -0.5, 0);                     // (1 - 0.5) / 2 × 63 = 15.75
    expect(m.cpu.read8(0x6808)).toBe(16);
    m.keyboard.selectLine(9);
    expect(m.keyboard.read() & 0x04).toBe(0);      // past half travel: digital left too
    joy.analog!('x', -0.3, 0);
    expect(m.keyboard.read() & 0x04).toBe(0x04);   // back inside: released
  });

  it('ignores CPU writes to the read-only channels', () => {
    const m = paged();
    m.cpu.write8(0x6808, 0x11);
    m.cpu.write8(0x680F, 0x22);
    expect(m.cpu.read8(0x6808)).toBe(0x20);
    expect(m.cpu.read8(0x680F)).toBe(0x00);
  });

  it('keeps the held stick through a reset (the stick, not the chip, holds it)', () => {
    const m = paged();
    m.services.input.joystick.press('right', true, 'keys', 0);
    m.reset();
    const asic = m.gateArray as Asic;
    expect(asic.registerPage[0x2808]).toBe(0x3F);
    expect(asic.registerPage[0x280C]).toBe(0x3F);
  });
});
