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
});
