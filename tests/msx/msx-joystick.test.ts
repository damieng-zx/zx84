/**
 * MsxJoystick + PSG I/O path.
 *
 * MSX joysticks read through the PSG: write reg 15 (bit 6 selects the port),
 * read reg 14 for that port's directions/triggers, active-low —
 * bit0 up, bit1 down, bit2 left, bit3 right, bit4 trigA, bit5 trigB; bits 6/7
 * stay high. This is exactly the sequence the BIOS GTSTCK/STICK uses via the
 * PSG ports 0xA0 (address), 0xA1 (write), 0xA2 (read).
 */
import { describe, it, expect } from 'vitest';
import { MsxJoystick } from '@/machines/msx/msx-joystick.ts';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';

describe('MsxJoystick', () => {
  it('encodes directions/triggers active-low for the selected port', () => {
    const j = new MsxJoystick();
    j.set('up', true, 0);
    j.set('left', true, 0);
    j.set('fire', true, 0);          // trigger A
    j.setSelect(0x00);               // select port 0
    // bits 0 (up), 2 (left), 4 (trigA) cleared.
    expect(j.read()).toBe(0xFF & ~(0x01 | 0x04 | 0x10) & 0xFF); // 0xEA
    // Bits 6 and 7 (pin-8 / cassette) stay high.
    expect(j.read() & 0xC0).toBe(0xC0);
  });

  it('reads only the selected port', () => {
    const j = new MsxJoystick();
    j.set('down', true, 1);          // port 2 (player index 1)
    j.setSelect(0x00);               // select port 0 → nothing pressed
    expect(j.read()).toBe(0xFF);
    j.setSelect(0x40);               // bit 6 = 1 → select port 1
    expect(j.read()).toBe(0xFF & ~0x02 & 0xFF); // down → bit1 clear = 0xFD
  });

  it('trigger B maps to bit 5', () => {
    const j = new MsxJoystick();
    j.set('fire2', true, 0);
    j.setSelect(0);
    expect(j.read()).toBe(0xFF & ~0x20 & 0xFF); // 0xDF
  });

  it('is read through PSG ports 0xA0/0xA1/0xA2 (the BIOS path)', () => {
    const m = new MsxMachine('hx-10', null);
    m.joystick.set('right', true, 0);       // port 1, right
    // Select port 0 via reg 15 bit6=0, then read reg 14.
    m.cpu.portOut(0xA0, 15); m.cpu.portOut(0xA1, 0x00);
    m.cpu.portOut(0xA0, 14);
    expect(m.cpu.portIn(0xA2)).toBe(0xFF & ~0x08 & 0xFF); // right → bit3 clear = 0xF7

    // Now port 2 pressed up; select bit6=1 and read.
    m.joystick.set('up', true, 1);
    m.cpu.portOut(0xA0, 15); m.cpu.portOut(0xA1, 0x40);
    m.cpu.portOut(0xA0, 14);
    expect(m.cpu.portIn(0xA2)).toBe(0xFF & ~0x01 & 0xFF); // up → bit0 clear = 0xFE
  });

  it('reset clears all ports', () => {
    const j = new MsxJoystick();
    j.set('up', true, 0);
    j.reset();
    j.setSelect(0);
    expect(j.read()).toBe(0xFF);
    expect(j.active).toBe(false);
  });
});
