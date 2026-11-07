/**
 * The 1351 mouse: its position reaches the program through the SID's POT
 * lines (6-bit counters in bits 1-6) on the control port CIA 1 port A bits 6-7
 * select, and its buttons read as the port's fire and up lines.
 */

import { describe, it, expect } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import { c64Descriptor } from '@/machines/c64/descriptor.ts';
import { C64_MOUSE_PORT1, C64_MOUSE_PORT2 } from '@/machines/c64/services/input.ts';

function machine(): C64Machine {
  const m = new C64Machine('c64', null);
  m.reset();
  m.cia1.ddra = 0xFF;
  return m;
}

/** Point the SID's pot lines at a control port, as the driver does through CIA 1. */
const select = (m: C64Machine, port: 1 | 2): void => { m.cia1.pra = port === 1 ? 0x40 : 0x80; };
const potX = (m: C64Machine): number => m.sid.read(0x19);
const potY = (m: C64Machine): number => m.sid.read(0x1A);

describe('the 1351 mouse', () => {
  it('is offered for either control port', () => {
    const ids = c64Descriptor('c64').ui.mouseTypes.map(t => t.id);
    expect(ids).toEqual([C64_MOUSE_PORT1, C64_MOUSE_PORT2]);
    expect(c64Descriptor('c64').ui.hiddenPanes).not.toContain('mouse-panel');
  });

  it('reads full scale when there is no mouse', () => {
    const m = machine();
    select(m, 1);
    expect(potX(m)).toBe(0xFF);
    expect(potY(m)).toBe(0xFF);
    m.destroy();
  });

  it('counts motion in the 6-bit POT fields, wrapping, with up counting up', () => {
    const m = machine();
    m.services.input.mice!.setMode(C64_MOUSE_PORT1);
    select(m, 1);
    expect(potX(m)).toBe(0);
    m.services.input.mice!.motion(5, 0, C64_MOUSE_PORT1);
    expect(potX(m)).toBe(10);                      // 5 << 1
    m.services.input.mice!.motion(0, -3, C64_MOUSE_PORT1);   // up the screen
    expect(potY(m)).toBe(6);
    m.services.input.mice!.motion(0, 10, C64_MOUSE_PORT1);   // down
    expect(potY(m)).toBe(((3 - 10) & 0x3F) << 1);
    m.services.input.mice!.motion(-6, 0, C64_MOUSE_PORT1);   // past zero: wraps
    expect(potX(m)).toBe(((5 - 6) & 0x3F) << 1);
    m.destroy();
  });

  it('cuts a flick to half a turn of the counter so a driver can tell the way', () => {
    const m = machine();
    m.services.input.mice!.setMode(C64_MOUSE_PORT1);
    select(m, 1);
    m.services.input.mice!.motion(500, 0, C64_MOUSE_PORT1);
    expect(potX(m)).toBe(31 << 1);
    m.destroy();
  });

  it('answers only on the port the lines are switched to', () => {
    const m = machine();
    m.services.input.mice!.setMode(C64_MOUSE_PORT2);
    m.services.input.mice!.motion(4, 0, C64_MOUSE_PORT2);
    select(m, 1);
    expect(potX(m)).toBe(0xFF);
    select(m, 2);
    expect(potX(m)).toBe(8);
    m.destroy();
  });

  it('presses the port\'s fire line with the left button and up with the right', () => {
    const m = machine();
    m.cia1.ddrb = 0; m.cia1.ddra = 0xC0;
    m.services.input.mice!.setMode(C64_MOUSE_PORT1);    // port 1 is CIA 1 port B
    expect(m.cia1.read(1) & 0x11).toBe(0x11);
    m.services.input.mice!.button(0, true, C64_MOUSE_PORT1);
    expect(m.cia1.read(1) & 0x11).toBe(0x01);           // fire (bit 4) low
    m.services.input.mice!.button(2, true, C64_MOUSE_PORT1);
    expect(m.cia1.read(1) & 0x11).toBe(0x00);           // and up (bit 0)
    m.services.input.mice!.button(0, false, C64_MOUSE_PORT1);
    m.services.input.mice!.button(2, false, C64_MOUSE_PORT1);
    expect(m.cia1.read(1) & 0x11).toBe(0x11);

    m.services.input.mice!.setMode(C64_MOUSE_PORT2);    // port 2 is CIA 1 port A
    m.services.input.mice!.button(0, true, C64_MOUSE_PORT2);
    expect(m.cia1.read(0) & 0x10).toBe(0);
    expect(m.cia1.read(1) & 0x10).toBe(0x10);
    m.destroy();
  });

  it('lets go when released', () => {
    const m = machine();
    m.cia1.ddrb = 0;
    m.services.input.mice!.setMode(C64_MOUSE_PORT1);
    m.services.input.mice!.button(0, true, C64_MOUSE_PORT1);
    m.services.input.mice!.setMode(null);
    expect(m.cia1.read(1) & 0x10).toBe(0x10);
    select(m, 1);
    expect(potX(m)).toBe(0xFF);
    m.destroy();
  });
});
