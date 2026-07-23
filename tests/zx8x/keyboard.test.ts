import { describe, expect, it } from 'vitest';
import { Zx8xKeyboard } from '@/machines/zx8x/keyboard.ts';

describe('ZX80/ZX81 keyboard', () => {
  it('maps host Space to the native keyboard matrix', () => {
    const keyboard = new Zx8xKeyboard();
    expect(keyboard.handleKeyEvent('Space', true)).toBe(true);
    expect(keyboard.read(0x7f) & 0x01).toBe(0);

    keyboard.handleKeyEvent('Space', false);
    expect(keyboard.read(0x7f) & 0x01).toBe(1);
  });

  it('drives a matrix bit by position via setKey', () => {
    const keyboard = new Zx8xKeyboard();
    // Q = row 2, bit 0. Select row 2 by clearing bit 2 of the high byte.
    keyboard.setKey(2, 0, true);
    expect(keyboard.read(0xfb) & 0x01).toBe(0);

    keyboard.setKey(2, 0, false);
    expect(keyboard.read(0xfb) & 0x01).toBe(1);
  });

  it('exposes the live matrix rows for highlight mirroring', () => {
    const keyboard = new Zx8xKeyboard();
    // Space = row 7, bit 0; active-low so the bit clears when pressed.
    keyboard.handleKeyEvent('Space', true);
    expect(keyboard.rows[7] & 0x01).toBe(0);

    keyboard.handleKeyEvent('Space', false);
    expect(keyboard.rows[7] & 0x01).toBe(1);
  });

  it('reference-counts a shared bit so on-screen and physical presses coexist', () => {
    const keyboard = new Zx8xKeyboard();
    // SHIFT = row 0, bit 0. Hold it from both the physical event and setKey.
    keyboard.handleKeyEvent('ShiftLeft', true);
    keyboard.setKey(0, 0, true);

    // Releasing the on-screen press must not clear the bit the physical key holds.
    keyboard.setKey(0, 0, false);
    expect(keyboard.read(0xfe) & 0x01).toBe(0);

    // Only when the last holder releases does the bit go high again.
    keyboard.handleKeyEvent('ShiftLeft', false);
    expect(keyboard.read(0xfe) & 0x01).toBe(1);
  });
});
