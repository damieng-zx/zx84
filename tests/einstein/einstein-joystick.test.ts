/**
 * Einstein joysticks: the TC-01's ADC0844 at ports 0x38-0x3F, the fire
 * buttons on status port 0x20 (bits 0/1, active low) with their interrupt,
 * and the Einstein 256's digital ports 0x30/0x32 and pseudo-ADC.
 *
 * The ADC0844's MUX address (b2 set = single-ended, b1-b0 the channel) starts
 * a conversion; the result is read back once INTR has asserted (ADC0844 data
 * sheet). Channel assignment and axis directions — CH1/CH2 joystick 1 X/Y,
 * CH3/CH4 joystick 2, X 0 at left, Y 255 at up — and the 256's port bits (b0
 * up, b1 down, b2 left, b3 right, b4 fire, all active low) follow MAME's
 * einstein driver, the only wiring description available; neither MOS 1.x
 * nor MOS 2.1 has a joystick routine to run instead (MOS 2.1 touches 0x30
 * and 0x32 only for its printer).
 */

import { describe, it, expect } from 'vitest';
import { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';

function machine(model: 'einstein-tc01' | 'einstein-256'): EinsteinMachine {
  const m = new EinsteinMachine(model, null);
  m.turbo = true;
  const rom = new Uint8Array(0x4000);
  rom.set([0xF3, 0x18, 0xFE], 0);              // DI; JR $
  m.loadROM(rom);
  m.reset();
  return m;
}

/** Start a conversion on `channel`, let it finish, read the result. */
function convert(m: EinsteinMachine, channel: number): number {
  m.cpu.portOut(0x38, 0x04 | channel);
  m.tick();
  return m.cpu.portIn(0x38);
}

describe('Einstein TC-01 ADC0844 joysticks', () => {
  it('converts a centred stick to 0x80 on every channel', () => {
    const m = machine('einstein-tc01');
    expect([0, 1, 2, 3].map(c => convert(m, c))).toEqual([0x80, 0x80, 0x80, 0x80]);
  });

  it('player 1 is channels 1/2, player 2 channels 3/4: X 0 at left, Y 0xFF at up', () => {
    const m = machine('einstein-tc01');
    const joy = m.services.input.joystick!;
    joy.press('left', true, 'kempston', 0);
    joy.press('up', true, 'kempston', 0);
    joy.press('right', true, 'kempston', 1);
    joy.press('down', true, 'kempston', 1);
    expect([0, 1, 2, 3].map(c => convert(m, c))).toEqual([0x00, 0xFF, 0xFF, 0x00]);
  });

  it('a gamepad axis is proportional', () => {
    const m = machine('einstein-tc01');
    m.services.input.joystick!.analog!('x', 0.5, 0);    // (0.5 + 1) / 2 × 255
    expect(convert(m, 0)).toBe(191);
  });

  it('keeps the result latched until the next conversion ends', () => {
    const m = machine('einstein-tc01');
    const joy = m.services.input.joystick!;
    expect(convert(m, 0)).toBe(0x80);
    joy.press('right', true, 'kempston', 0);
    expect(m.cpu.portIn(0x3C)).toBe(0x80);             // A0-A2 mirror; not reconverted
    expect(convert(m, 0)).toBe(0xFF);
  });

  it('fire pulls status bit 0 (player 1) or bit 1 (player 2) low and raises the fire request', () => {
    const m = machine('einstein-tc01');
    const joy = m.services.input.joystick!;
    expect(m.cpu.portIn(0x20) & 0x03).toBe(0x03);
    joy.press('fire', true, 'kempston', 1);
    expect(m.cpu.portIn(0x20) & 0x03).toBe(0x01);
    joy.press('fire', true, 'kempston', 0);
    expect(m.cpu.portIn(0x20) & 0x03).toBe(0x00);
    m.scanBoardInterrupts();
    expect(m.boardIntPending & 0x04).toBe(0x04);
  });
});

describe('Einstein 256 joystick ports', () => {
  it('reads directions and fire, active low, player 1 on port 0x32 and player 2 on 0x30', () => {
    const m = machine('einstein-256');
    const joy = m.services.input.joystick!;
    expect(m.cpu.portIn(0x32) & 0x1F).toBe(0x1F);
    joy.press('up', true, 'kempston', 0);
    joy.press('right', true, 'kempston', 0);
    joy.press('fire', true, 'kempston', 0);
    expect(m.cpu.portIn(0x32) & 0x1F).toBe(0x1F & ~0x01 & ~0x08 & ~0x10);
    expect(m.cpu.portIn(0x30) & 0x1F).toBe(0x1F);
    expect(m.cpu.portIn(0x20) & 0x03).toBe(0x02);        // player 1's fire is status bit 0
    joy.press('left', true, 'kempston', 1);
    joy.press('down', true, 'kempston', 1);
    expect(m.cpu.portIn(0x30) & 0x1F).toBe(0x1F & ~0x02 & ~0x04);
  });

  it('the pseudo-ADC reads X/Y as 0x00, 0x7F or 0xFF for the selected port', () => {
    const m = machine('einstein-256');
    const joy = m.services.input.joystick!;
    const read = (sel: number): number => { m.cpu.portOut(0x38, sel); return m.cpu.portIn(0x38); };
    expect(read(0x04)).toBe(0x7F);
    joy.press('right', true, 'kempston', 0);
    joy.press('down', true, 'kempston', 0);
    expect(read(0x04)).toBe(0xFF);                     // X, port B (player 1): right
    expect(read(0x05)).toBe(0x00);                     // Y: down
    expect(read(0x06)).toBe(0x7F);                     // port A (player 2): centred
    joy.press('left', true, 'kempston', 1);
    joy.press('up', true, 'kempston', 1);
    expect(read(0x06)).toBe(0x00);
    expect(read(0x07)).toBe(0xFF);
    expect(read(0x00)).toBe(0x7F);                     // not an axis selection
  });
});
