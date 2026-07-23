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

  it('maps player one to the right cursor/Home joystick socket', () => {
    const keyboard = new MtxKeyboard();
    keyboard.setJoystick('left', true, 0);
    keyboard.setJoystick('fire', true, 0);

    keyboard.selectDrive(0xD7); // drive lines 3 and 5

    expect(keyboard.readSenseLow()).toBe(0x7F);
  });

  it('maps player two to the left Z/C/B/M/Space joystick socket', () => {
    const keyboard = new MtxKeyboard();
    keyboard.setJoystick('right', true, 1);
    keyboard.setJoystick('down', true, 1);
    keyboard.setJoystick('fire', true, 1);

    keyboard.selectDrive(0x7F); // drive line 7

    expect(keyboard.readSenseLow()).toBe(0xF5);
    expect(keyboard.readSenseHigh()).toBe(0x02);
  });

  it('keeps a shared matrix cell active until both key and joystick release it', () => {
    const keyboard = new MtxKeyboard();
    keyboard.handleKeyEvent('ArrowLeft', true);
    keyboard.setJoystick('left', true, 0);
    keyboard.selectDrive(0xF7);

    keyboard.handleKeyEvent('ArrowLeft', false);
    expect(keyboard.readSenseLow()).toBe(0x7F);

    keyboard.setJoystick('left', false, 0);
    expect(keyboard.readSenseLow()).toBe(0xFF);
  });
});
