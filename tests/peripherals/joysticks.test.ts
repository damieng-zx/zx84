/**
 * Joystick peripherals: Kempston hardware bits + keyboard-mapped modes
 * (Cursor, Sinclair 1, Sinclair 2).
 *
 * The keyboard-mapped modes press Spectrum matrix keys at known [row, bit]
 * positions. No mode presses Caps Shift: the Cursor (AGF/Protek) interface is
 * wired to the 5/6/7/8/0 keys alone.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  KempstonJoystick,
  KEMPSTON_BITS,
  CURSOR_KEYS,
  SINCLAIR1_KEYS,
  SINCLAIR2_KEYS,
  joyPressForType,
} from '@/machines/spectrum/peripherals/joysticks.ts';

import { SpectrumKeyboard } from '@/machines/spectrum/keyboard.ts';

describe('KempstonJoystick', () => {
  let j: KempstonJoystick;
  beforeEach(() => { j = new KempstonJoystick(); });

  it('initial state is 0 (all directions released)', () => {
    expect(j.state).toBe(0);
  });

  it('press sets the documented Kempston bits (active high)', () => {
    // 0=right, 1=left, 2=down, 3=up, 4=fire
    j.press('right', true);
    expect(j.state).toBe(0b00001);
    j.press('up', true);
    expect(j.state).toBe(0b01001);
    j.press('fire', true);
    expect(j.state).toBe(0b11001);
  });

  it('release clears only the relevant bit', () => {
    j.press('left', true);
    j.press('fire', true);
    j.press('left', false);
    expect(j.state).toBe(0b10000);
  });

  it('unknown direction is a no-op', () => {
    j.press('diagonal-up-left', true);
    expect(j.state).toBe(0);
  });

  it('reset clears all directions', () => {
    j.press('up', true);
    j.press('fire', true);
    j.reset();
    expect(j.state).toBe(0);
  });

  it('KEMPSTON_BITS exposes the canonical assignment', () => {
    expect(KEMPSTON_BITS).toEqual({ right: 0, left: 1, down: 2, up: 3, fire: 4 });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Keyboard-mapped joystick modes
// ─────────────────────────────────────────────────────────────────────────

/** Mock Spectrum exposing only what joyPressForType touches. */
function mockSpectrum() {
  return {
    joystick: new KempstonJoystick(),
    keyboard: new SpectrumKeyboard(),
  };
}

function isPressed(kbd: SpectrumKeyboard, row: number, bit: number): boolean {
  return (kbd.rows[row] & (1 << bit)) === 0;
}

describe('joyPressForType — mode dispatch', () => {
  it("mode 'none' does nothing", () => {
    const s = mockSpectrum();
    joyPressForType(s as any, 'fire', true, 'none');
    expect(s.joystick.state).toBe(0);
    expect(s.keyboard.rows.every(r => r === 0xFF)).toBe(true);
  });

  it("mode 'kempston' goes to the hardware joystick", () => {
    const s = mockSpectrum();
    joyPressForType(s as any, 'up', true, 'kempston');
    expect(s.joystick.state).toBe(1 << KEMPSTON_BITS.up);
    expect(s.keyboard.rows.every(r => r === 0xFF)).toBe(true);
  });

  it("mode 'sinclair1' presses the documented number keys (row 4: 0,9,8,7,6)", () => {
    const s = mockSpectrum();
    for (const dir of ['left', 'right', 'up', 'down', 'fire'] as const) {
      joyPressForType(s as any, dir, true, 'sinclair1');
      const k = SINCLAIR1_KEYS[dir];
      expect(isPressed(s.keyboard, k.row, k.bit)).toBe(true);
    }
    // Caps Shift must NOT be held for sinclair1.
    expect(isPressed(s.keyboard, 0, 0)).toBe(false);
  });

  it("mode 'sinclair2' presses the documented number keys (row 3: 1,2,3,4,5)", () => {
    const s = mockSpectrum();
    joyPressForType(s as any, 'fire', true, 'sinclair2');
    const k = SINCLAIR2_KEYS.fire;
    expect(isPressed(s.keyboard, k.row, k.bit)).toBe(true);
    expect(isPressed(s.keyboard, 0, 0)).toBe(false);
  });

  it("mode 'cursor' presses only the 5/6/7/8/0 keys and never Caps Shift", () => {
    const s = mockSpectrum();
    for (const dir of ['left', 'down', 'up', 'right', 'fire'] as const) {
      joyPressForType(s as any, dir, true, 'cursor');
      const k = CURSOR_KEYS[dir];
      expect(isPressed(s.keyboard, k.row, k.bit)).toBe(true);
      expect(isPressed(s.keyboard, 0, 0)).toBe(false);
    }
    for (const dir of ['left', 'down', 'up', 'right', 'fire'] as const) {
      joyPressForType(s as any, dir, false, 'cursor');
      const k = CURSOR_KEYS[dir];
      expect(isPressed(s.keyboard, k.row, k.bit)).toBe(false);
    }
    expect(s.keyboard.rows.every(r => r === 0xFF)).toBe(true);
  });

  it('unknown direction with keyboard mode is a no-op (key not in map)', () => {
    const s = mockSpectrum();
    joyPressForType(s as any, 'diagonal', true, 'sinclair1');
    expect(s.keyboard.rows.every(r => r === 0xFF)).toBe(true);
  });
});

describe('joystick key-map tables: documented Spectrum positions', () => {
  it('CURSOR_KEYS = 5(left), 6(down), 7(up), 8(right), 0(fire) — no Caps Shift', () => {
    expect(CURSOR_KEYS.left).toEqual({ row: 3, bit: 4 }); // 5
    expect(CURSOR_KEYS.down).toEqual({ row: 4, bit: 4 }); // 6
    expect(CURSOR_KEYS.up).toEqual({ row: 4, bit: 3 });   // 7
    expect(CURSOR_KEYS.right).toEqual({ row: 4, bit: 2 });// 8
    expect(CURSOR_KEYS.fire).toEqual({ row: 4, bit: 0 }); // 0
  });

  it('SINCLAIR1_KEYS = 6,7,8,9,0 (row 4)', () => {
    expect(SINCLAIR1_KEYS.fire).toEqual({ row: 4, bit: 0 });   // 0
    expect(SINCLAIR1_KEYS.up).toEqual({ row: 4, bit: 1 });     // 9
    expect(SINCLAIR1_KEYS.down).toEqual({ row: 4, bit: 2 });   // 8
    expect(SINCLAIR1_KEYS.right).toEqual({ row: 4, bit: 3 });  // 7
    expect(SINCLAIR1_KEYS.left).toEqual({ row: 4, bit: 4 });   // 6
  });

  it('SINCLAIR2_KEYS = 1,2,3,4,5 (row 3)', () => {
    expect(SINCLAIR2_KEYS.left).toEqual({ row: 3, bit: 0 });   // 1
    expect(SINCLAIR2_KEYS.right).toEqual({ row: 3, bit: 1 });  // 2
    expect(SINCLAIR2_KEYS.down).toEqual({ row: 3, bit: 2 });   // 3
    expect(SINCLAIR2_KEYS.up).toEqual({ row: 3, bit: 3 });     // 4
    expect(SINCLAIR2_KEYS.fire).toEqual({ row: 3, bit: 4 });   // 5
  });
});
