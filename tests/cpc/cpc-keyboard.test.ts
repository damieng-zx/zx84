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
  it('exposes the live active-low rows for CPC-owned UI highlighting', () => {
    const kb = new CpcKeyboard();
    kb.setKey(8, 2, true);
    expect(kb.rows[8] & 0x04).toBe(0);
    kb.setKey(8, 2, false);
    expect(kb.rows[8] & 0x04).toBe(0x04);
  });

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

/**
 * Character-intent typing. The expected cells are the CPC's own UK key legends
 * (CPCTech's 10×8 matrix table, and the legend printed on the caps), which differ
 * from a PC keyboard's on nearly every symbol key. The SHIFT cell is [2,5].
 */
describe('CpcKeyboard character-intent typing', () => {
  /** The character typed for ch: which cell went low, and whether SHIFT did. */
  function typed(ch: string): { cell: string; shift: boolean } {
    const kb = new CpcKeyboard();
    kb.handleEvent({ code: '', key: ch, shift: false, ctrl: false, alt: false }, true);
    const down: string[] = [];
    for (let line = 0; line < 10; line++) {
      const bits = readLine(kb, line) ^ 0xFF;
      for (let bit = 0; bit < 8; bit++) if (bits & (1 << bit)) down.push(`${line}/${bit}`);
    }
    const shift = down.includes('2/5');
    const cells = down.filter(c => c !== '2/5');
    expect(cells).toHaveLength(1);
    return { cell: cells[0], shift };
  }

  it('types + as Shift+; (matrix 3/4), not the PC Shift+= key', () => {
    // '+' is the shifted legend of the ';' key on a CPC; the PC's '=' key
    // carries '↑'/'£', so mapping the physical code would type the wrong glyph.
    expect(typed('+')).toEqual({ cell: '3/4', shift: true });
  });

  it('types * as Shift+: (matrix 3/5)', () => {
    expect(typed('*')).toEqual({ cell: '3/5', shift: true });
  });

  it('types " as Shift+2 (matrix 8/1)', () => {
    expect(typed('"')).toEqual({ cell: '8/1', shift: true });
  });

  it('types | as Shift+@ (matrix 3/2) — the key left of Z', () => {
    expect(typed('|')).toEqual({ cell: '3/2', shift: true });
  });

  it('types @ as the unshifted @ key (matrix 3/2)', () => {
    expect(typed('@')).toEqual({ cell: '3/2', shift: false });
  });

  it('types < as Shift+, (matrix 4/7) and > as Shift+. (matrix 3/7)', () => {
    expect(typed('<')).toEqual({ cell: '4/7', shift: true });
    expect(typed('>')).toEqual({ cell: '3/7', shift: true });
  });

  it('types : unshifted (matrix 3/5) and ; unshifted (matrix 3/4)', () => {
    expect(typed(':')).toEqual({ cell: '3/5', shift: false });
    expect(typed(';')).toEqual({ cell: '3/4', shift: false });
  });

  it('types = as Shift+- (matrix 3/1)', () => {
    expect(typed('=')).toEqual({ cell: '3/1', shift: true });
  });

  it('types _ as Shift+0 (matrix 4/0) and the shifted digit symbols', () => {
    expect(typed('_')).toEqual({ cell: '4/0', shift: true });
    expect(typed('!')).toEqual({ cell: '8/0', shift: true });
    expect(typed('&')).toEqual({ cell: '6/0', shift: true });
  });

  it('types upper case as Shift+letter and lower case unshifted', () => {
    // Measured on the firmware: matrix 8/5 echoes "a" unshifted and "A" with
    // SHIFT held, so case comes from SHIFT, not from a separate cell.
    expect(typed('a')).toEqual({ cell: '8/5', shift: false });
    expect(typed('A')).toEqual({ cell: '8/5', shift: true });
  });

  it('SHIFT is released only when no shifted character is still held', () => {
    const kb = new CpcKeyboard();
    const ev = (key: string) => ({ code: '', key, shift: false, ctrl: false, alt: false });
    kb.handleEvent(ev('+'), true);
    kb.handleEvent(ev('!'), true);
    kb.handleEvent(ev('+'), false);
    // '!' still needs SHIFT.
    expect(readLine(kb, 2) & 0x20).toBe(0);
    kb.handleEvent(ev('!'), false);
    expect(readLine(kb, 2) & 0x20).toBe(0x20);
  });

  it('the character decides SHIFT, not a physically held one', () => {
    // A browser folds SHIFT into event.key: US Shift+2 arrives as "@". Adding
    // matrix SHIFT again would type "|" (the shifted legend of the @ key), so
    // the held modifier must not override the character's own legend.
    const kb = new CpcKeyboard();
    const shift = { code: 'ShiftLeft', key: 'Shift', shift: true, ctrl: false, alt: false };
    kb.handleEvent(shift, true);
    // "@" is unshifted on the CPC's @ key, so no extra SHIFT should be applied
    // beyond the physical key the host is holding.
    kb.handleEvent({ code: 'Digit2', key: '@', shift: true, ctrl: false, alt: false }, true);
    expect(readLine(kb, 3) & 0x04).toBe(0); // matrix 3/2 (@) is down
    kb.handleEvent({ code: 'Digit2', key: '@', shift: true, ctrl: false, alt: false }, false);
    kb.handleEvent(shift, false);
    expect(readLine(kb, 2)).toBe(0xFF);
  });

  it('honours a physically held SHIFT (shift+2 types the shifted legend)', () => {
    // The MCP `key "shift+2"` tool sends SHIFT as its own event with the key
    // named "2", so the shifted legend of that key's cell comes out.
    const kb = new CpcKeyboard();
    const shift = { code: 'ShiftLeft', key: 'Shift', shift: true, ctrl: false, alt: false };
    kb.handleEvent(shift, true);
    expect(readLine(kb, 2) & 0x20).toBe(0); // SHIFT down on the matrix
    kb.handleEvent({ code: 'Digit2', key: '2', shift: true, ctrl: false, alt: false }, true);
    expect(readLine(kb, 8) & 0x02).toBe(0); // Digit2's cell went low
    kb.handleEvent({ code: 'Digit2', key: '2', shift: true, ctrl: false, alt: false }, false);
    kb.handleEvent(shift, false);
    expect(readLine(kb, 2) & 0x20).toBe(0x20); // SHIFT released
    expect(readLine(kb, 8)).toBe(0xFF);
  });

  it('falls through to the physical code for keys with no legend (Enter, cursors)', () => {
    const kb = new CpcKeyboard();
    expect(kb.handleEvent({ code: 'Enter', key: 'Enter', shift: false, ctrl: false, alt: false }, true)).toBe(true);
    expect(readLine(kb, 2) & 0x04).toBe(0); // Enter is matrix 2/2
    expect(kb.handleEvent({ code: 'ArrowLeft', key: 'ArrowLeft', shift: false, ctrl: false, alt: false }, true)).toBe(true);
    expect(readLine(kb, 1) & 0x01).toBe(0); // cursor-left is matrix 1/0
  });

  it('presses SHIFT on its own matrix cell and releases it again', () => {
    const kb = new CpcKeyboard();
    const shift = { code: 'ShiftLeft', key: 'Shift', shift: true, ctrl: false, alt: false };
    expect(kb.handleEvent(shift, true)).toBe(true);
    expect(readLine(kb, 2) & 0x20).toBe(0); // SHIFT cell 2/5 is low
    kb.handleEvent(shift, false);
    expect(readLine(kb, 2)).toBe(0xFF);
  });
});

