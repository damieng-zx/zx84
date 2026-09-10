/**
 * The Lynx's port decode. The keyboard is the reason this is unusual: there is
 * no line-select register, so the line rides in A8-A11 of a read at port 0x80.
 */

import { describe, it, expect } from 'vitest';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';
import type { LynxModel } from '@/machines/lynx/models.ts';

function machine(model: LynxModel = 'lynx48'): LynxMachine {
  const m = new LynxMachine(model, null);
  m.loadROM(new Uint8Array(0x4000));
  m.reset();
  return m;
}

describe('Lynx port I/O', () => {
  it('reads the keyboard line named by A8-A11 of a read at 0x80', () => {
    const m = machine();
    m.keyboard.setKey(3, 5, true);
    expect(m.cpu.portIn(0x0380)).toBe(0xdf);   // line 3, bit 5 low
    expect(m.cpu.portIn(0x0480)).toBe(0xff);   // any other line is idle
    // A12-A15 are mirror, so the same line answers from the top of the map.
    expect(m.cpu.portIn(0xf380)).toBe(0xdf);
  });

  it('counts keyboard reads for the KEY activity light', () => {
    const m = machine();
    m.activity.kbdReads = 0;
    m.cpu.portIn(0x0080);
    m.cpu.portIn(0x0180);
    expect(m.activity.kbdReads).toBe(2);
  });

  it('sends port 0x84 to the DAC, or to the tape once the motor runs', () => {
    const m = machine();
    m.cpu.portOut(0x0084, 0x5a);
    expect(m.dacLevel).toBe(0x5a);

    m.cpu.portOut(0x0080, 0x02);               // 48K motor bit
    expect(m.tapeMotorOn).toBe(true);
    m.cpu.portOut(0x0084, 0x7f);
    expect(m.dacLevel).toBe(0x5a);             // held: that write went to tape
  });

  it('moves the 128K motor bit, and gives it its own cassette-in port', () => {
    const m = machine('lynx128');
    m.cpu.portOut(0x0080, 0x02);
    expect(m.tapeMotorOn).toBe(false);         // bit 1 is not the motor here
    m.cpu.portOut(0x0080, 0x08);
    expect(m.tapeMotorOn).toBe(true);
    // Port 0x82 reads the serial buffer, whose bit 2 is the tape signal.
    expect(m.cpu.portIn(0x0082) & 0x04).toBe(0);
  });

  it('takes the bank port at 0x7F on the 48K and at 0x82 on the 128K', () => {
    const before48 = [...machine().memory.pages];
    const m48 = machine();
    m48.cpu.portOut(0x007f, 0x20 ^ 0x31);      // read bank 1 only
    expect([...m48.memory.pages]).not.toEqual(before48);
    m48.cpu.portOut(0x0082, 0x00);             // no such port here
    expect([...m48.memory.pages]).toEqual([8, 9, 10, 11, 12, 13, 14, 7]);

    const m128 = machine('lynx128');
    const before128 = [...m128.memory.pages];
    m128.cpu.portOut(0x007f, 0xff);            // no such port on this board
    expect([...m128.memory.pages]).toEqual(before128);
    m128.cpu.portOut(0x0082, 0x04 ^ 0x8c);     // read bank 1 only
    expect([...m128.memory.pages]).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('reads the FDC at 0x50-0x53 and writes it at 0x54-0x57', () => {
    const m = machine('lynx96');
    m.fdc.trackReg = 0x2a;
    expect(m.cpu.portIn(0x0051)).toBe(0x2a);
    m.cpu.portOut(0x0055, 0x13);
    expect(m.fdc.trackReg).toBe(0x13);
    expect(m.activity.fdcAccesses).toBeGreaterThan(0);
  });

  it('leaves the FDC ports open on the 48K, which has no disk interface', () => {
    const m = machine('lynx48');
    expect(m.hasDisk).toBe(false);
    expect(m.cpu.portIn(0x0050)).toBe(0xff);
    expect(m.activity.fdcAccesses).toBe(0);
  });
});
