import { describe, expect, it } from 'vitest';
import { MtxKeyboard } from '@/machines/mtx/mtx-keyboard.ts';

describe('MTX keyboard matrix', () => {
  it('returns active-low key state for a selected drive line', () => {
    const keyboard = new MtxKeyboard();
    keyboard.handleKeyEvent('KeyA', true); // drive 5, sense 0
    keyboard.selectDrive(0xDF);

    expect(keyboard.readSenseLow()).toBe(0xFE);
  });

  it('ANDs sense results when multiple drive lines are selected', () => {
    const keyboard = new MtxKeyboard();
    keyboard.handleKeyEvent('KeyA', true); // drive 5, sense 0
    keyboard.handleKeyEvent('KeyB', true); // drive 7, sense 2
    keyboard.selectDrive(0x5F);

    expect(keyboard.readSenseLow()).toBe(0xFA);
  });

  it('reports function keys through the two high sense lines', () => {
    const keyboard = new MtxKeyboard();
    keyboard.handleKeyEvent('F1', true); // drive 0, sense 9
    keyboard.selectDrive(0xFE);

    expect(keyboard.readSenseHigh()).toBe(0x01);
  });
});
