/**
 * Kempston Mouse: X/Y wrapping counters and active-low button mapping.
 *
 * Reference: https://k1.spdns.de/Develop/Projects/zasm/Info/Hardware%20Info/Kempston%20Mouse.html
 *   X register at port 0xFBDF, Y at 0xFFDF, buttons at 0xFADF (active-low).
 *   Button bits: 0=left, 1=right, 2=middle.
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

  it('setButton maps to documented bits (left=0, right=1, middle=2) active-low', () => {
    m.setButton(0, true); // left
    expect(m.buttons).toBe(0xFF & ~0x01);
    m.setButton(2, true); // right (button index 2 → bit 1)
    expect(m.buttons).toBe(0xFF & ~0x01 & ~0x02);
    m.setButton(1, true); // middle (button index 1 → bit 2)
    expect(m.buttons).toBe(0xFF & ~0x07);

    m.setButton(0, false);
    expect(m.buttons & 0x01).toBe(0x01);
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
