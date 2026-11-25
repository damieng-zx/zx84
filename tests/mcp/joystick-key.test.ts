/**
 * The MCP `key` tool's joystick names.
 *
 * Expectations come from the hardware. On the Commodore 64 control port 1 is
 * CIA 1 port B ($DC01, shared with the keyboard) and control port 2 is CIA 1
 * port A ($DC00); on both, bit 0 is up, 1 down, 2 left, 3 right and 4 fire,
 * each active low (the MOS 6526 data book: a port bit reads 0 while its line
 * is pulled down), so a line that is pressed reads 0 and everything else on
 * the port reads 1. Player 1's stick is in port 1 and player 2's in port 2.
 */

import { describe, it, expect } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { holdKey, joystickMode } from '../../mcp/tools/io.ts';
import { state } from '../../mcp/state.ts';
import type { JoystickInput } from '../../src/machines/machine.ts';

/** What control port 2 (CIA 1 port A) and port 1 (port B) show: 1 = released. */
function ports(m: C64Machine): [number, number] {
  return [m.cia1.read(0xDC00) & 0x1F, m.cia1.read(0xDC01) & 0x1F];
}

function onC64(): C64Machine {
  const m = new C64Machine('c64', null);
  m.reset();
  state.spec = m;
  state.model = 'c64';
  return m;
}

describe('MCP key tool: joystick names', () => {
  it('sends player 1 to control port 1 and player 2 to control port 2, and releases both', () => {
    const m = onC64();
    expect(ports(m)).toEqual([0b11111, 0b11111]);
    expect(holdKey('joy-up+joy-fire-p2', 3)).toBe("Key 'joy-up+joy-fire-p2' held for 3 frames");
    // Nothing may be left held: a game must not see a stuck direction afterwards.
    expect(ports(m)).toEqual([0b11111, 0b11111]);
    m.destroy();
  });

  it('pulls the port lines low while held, on the right port, and releases them', () => {
    const m = onC64();
    // Record what the ports show after each press and release the tool makes.
    const seen: number[] = [];
    const real = m.services.input.joystick!;
    (m.services.input as { joystick: JoystickInput | null }).joystick = {
      ...real,
      press: (dir, pressed, mode, player) => { real.press(dir, pressed, mode, player); seen.push((ports(m)[0] << 8) | ports(m)[1]); },
    };
    holdKey('joy-left+joy-fire-p2', 2);
    expect(seen).toEqual([
      (0b11111 << 8) | 0b11011,   // player 1 left: port B (control port 1) bit 2 low
      (0b01111 << 8) | 0b11011,   // player 2 fire: port A (control port 2) bit 4 low
      (0b01111 << 8) | 0b11111,   // left released
      (0b11111 << 8) | 0b11111,   // fire released
    ]);
    m.destroy();
  });

  it('names every direction and both fires, and refuses anything else before pressing a thing', () => {
    const m = onC64();
    const calls: string[] = [];
    const real = m.services.input.joystick!;
    const spy: JoystickInput = { ...real, press: (dir, pressed) => { calls.push(`${dir}:${pressed}`); } };
    (m.services.input as { joystick: JoystickInput | null }).joystick = spy;

    expect(holdKey('joy-fire2-p2', 1)).toBe("Key 'joy-fire2-p2' held for 1 frames");
    expect(calls).toEqual(['fire2:true', 'fire2:false']);
    calls.length = 0;
    expect(holdKey('joy-diagonal', 1)).toContain('Unknown key: joy-diagonal');
    expect(holdKey('joy-up+nope', 1)).toContain('Unknown key: nope');
    expect(holdKey('joy-up-p3', 1)).toContain('Unknown key: joy-up-p3');
    expect(calls, 'an unknown part presses nothing').toEqual([]);
    m.destroy();
  });

  it("says a machine with no joystick has none, instead of pressing", () => {
    const m = onC64();
    (m.services.input as { joystick: JoystickInput | null }).joystick = null;
    expect(holdKey('joy-fire', 1)).toBe("Key 'joy-fire' is not present on C64");
    m.destroy();
  });

  it('gives each player the interface at their position, as the Joystick pane does', () => {
    const c64 = new C64Machine('c64', null);
    expect(joystickMode(c64.descriptor.ui, 0)).toBe('c64-port1');
    expect(joystickMode(c64.descriptor.ui, 1)).toBe('c64-port2');
    // One interface: player 2 gets it too.
    const single = { ...c64.descriptor.ui, joystickTypes: c64.descriptor.ui.joystickTypes!.slice(0, 1) };
    expect(joystickMode(single, 1)).toBe('c64-port1');
    // A machine with no list of its own is offered the Spectrum's, Kempston first.
    expect(joystickMode({ ...c64.descriptor.ui, joystickTypes: undefined }, 0)).toBe('kempston');
    // And the Spectrum's own list orders them the same way.
    const zx = new Spectrum('zx48k', null);
    expect(joystickMode(zx.descriptor.ui, 0)).toBe('kempston');
    c64.destroy();
    zx.destroy();
  });
});
