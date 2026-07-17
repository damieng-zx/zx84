/**
 * CpcKeyboard — joystick multiplexing onto the keyboard matrix.
 *
 * The CPC reads each scanned line active-low (0 = pressed). Joystick 0 (P1) is
 * wired to matrix line 9 and joystick 1 (P2) to line 6, both with the bit
 * layout: 0 up, 1 down, 2 left, 3 right, 4 fire2, 5 fire1. These expectations
 * are derived from the CPC hardware matrix, not from the implementation.
 */

import { describe, it, expect } from 'vitest';
import { CpcKeyboard } from '@/machines/cpc/cpc-keyboard.ts';

/** Read a matrix line by selecting it then reading (the only public surface). */
function readLine(kb: CpcKeyboard, line: number): number {
  kb.selectLine(line);
  return kb.read();
}

describe('CpcKeyboard joystick multiplexing', () => {
  it('player 1 directions/fires clear the matching bits on line 9 only', () => {
    const kb = new CpcKeyboard();
    expect(readLine(kb, 9)).toBe(0xFF);

    kb.setJoystick('up', true, 0);     // bit 0
    kb.setJoystick('right', true, 0);  // bit 3
    kb.setJoystick('fire1', true, 0);  // bit 5
    // 0xFF with bits 0,3,5 cleared = 0xFF & ~0b00101001 = 0xD6
    expect(readLine(kb, 9)).toBe(0xD6);
    // Line 6 is untouched by player 1.
    expect(readLine(kb, 6)).toBe(0xFF);
  });

  it('player 2 directions/fires clear the matching bits on line 6 only', () => {
    const kb = new CpcKeyboard();
    kb.setJoystick('down', true, 1);   // bit 1
    kb.setJoystick('left', true, 1);   // bit 2
    kb.setJoystick('fire2', true, 1);  // bit 4
    // 0xFF & ~0b00010110 = 0xE9
    expect(readLine(kb, 6)).toBe(0xE9);
    // Line 9 (player 1) is untouched by player 2.
    expect(readLine(kb, 9)).toBe(0xFF);
  });

  it('defaults to player 0 (line 9) when the player argument is omitted', () => {
    const kb = new CpcKeyboard();
    kb.setJoystick('fire1', true);     // bit 5, line 9
    expect(readLine(kb, 9)).toBe(0xFF & ~(1 << 5));
    expect(readLine(kb, 6)).toBe(0xFF);
  });

  it('release restores the bit (press then release returns to 0xFF)', () => {
    const kb = new CpcKeyboard();
    kb.setJoystick('up', true, 1);
    expect(readLine(kb, 6)).toBe(0xFF & ~1);
    kb.setJoystick('up', false, 1);
    expect(readLine(kb, 6)).toBe(0xFF);
  });

  it('the two players are independent (P1 up and P2 up hit different lines)', () => {
    const kb = new CpcKeyboard();
    kb.setJoystick('up', true, 0);
    kb.setJoystick('up', true, 1);
    expect(readLine(kb, 9)).toBe(0xFF & ~1); // P1 up
    expect(readLine(kb, 6)).toBe(0xFF & ~1); // P2 up
  });
});
