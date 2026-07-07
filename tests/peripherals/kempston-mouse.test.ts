/**
 * Kempston Mouse: X/Y wrapping counters and active-low button mapping.
 *
 * X register at port 0xFBDF, Y at 0xFFDF, buttons at 0xFADF (active-low).
 * Button bits: D0 = RIGHT, D1 = LEFT, D2 = middle — per the WoS hardware
 * FAQ ports reference and FUSE (ui.c ui_mouse_button: X11 button 1/left →
 * kempmouse bit 1, button 3/right → bit 0 with swap_buttons off).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { KempstonMouse } from '@/peripherals/kempston-mouse.ts';

describe('KempstonMouse', () => {
  let m: KempstonMouse;
  beforeEach(() => { m = new KempstonMouse(); });

  it('initial state: counters zero, all buttons released (0xFF)', () => {
    expect(m.x).toBe(0);
    expect(m.y).toBe(0);
    expect(m.buttons).toBe(0xFF);
    expect(m.enabled).toBe(false);
  });

  it('updatePosition accumulates and wraps mod 256', () => {
    m.updatePosition(10, 20);
    expect(m.x).toBe(10);
    expect(m.y).toBe(20);

    m.updatePosition(-15, -25); // negatives become positive mod 256
    expect(m.x).toBe((10 - 15) & 0xFF); // 0xFB
    expect(m.y).toBe((20 - 25) & 0xFF); // 0xFB

    m.x = 0; m.y = 0;
    m.updatePosition(300, 400);
    expect(m.x).toBe(300 & 0xFF);
    expect(m.y).toBe(400 & 0xFF);
  });

  it('setButton maps to hardware bits (right=D0, left=D1, middle=D2) active-low', () => {
    m.setButton(0, true); // DOM left → bit 1
    expect(m.buttons).toBe(0xFF & ~0x02);
    m.setButton(2, true); // DOM right → bit 0
    expect(m.buttons).toBe(0xFF & ~0x02 & ~0x01);
    m.setButton(1, true); // DOM middle → bit 2
    expect(m.buttons).toBe(0xFF & ~0x07);

    m.setButton(0, false);
    expect(m.buttons & 0x02).toBe(0x02);
    m.setButton(1, false);
    m.setButton(2, false);
    expect(m.buttons).toBe(0xFF);
  });

  it('setButton ignores unknown button indices', () => {
    const before = m.buttons;
    m.setButton(99, true);
    m.setButton(-1, true);
    expect(m.buttons).toBe(before);
  });

  it('reset clears X/Y/buttons but preserves the enabled user preference', () => {
    m.enabled = true;
    m.x = 42; m.y = 99; m.buttons = 0;
    m.reset();
    expect(m.x).toBe(0);
    expect(m.y).toBe(0);
    expect(m.buttons).toBe(0xFF);
    expect(m.enabled).toBe(true);
  });
});
