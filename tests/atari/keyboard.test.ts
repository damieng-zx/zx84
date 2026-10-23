/**
 * Host-key mapping tests.
 *
 * Expected key codes come from the Atari keyboard matrix / OS tables, not from
 * the mapper: A is $3F, Z is $17, the number row is $1F/$1E/$1A/$18/$1D/
 * $1B/$33/$35/$30/$32, and the punctuation legends select the key and shift
 * state that the OS's shifted table expects.
 */

import { describe, it, expect } from 'vitest';
import { CONSOLE_KEYS, mapAtariKey, isModifierKey } from '@/machines/atari/keyboard.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

function key(code: string, value: string, shift = false, ctrl = false): HostKeyEvent {
  return { code, key: value, shift, ctrl, alt: false };
}

describe('atari keyboard letters and digits', () => {
  it.each([
    ['KeyA', 'a', 0x3f],
    ['KeyZ', 'z', 0x17],
    ['KeyQ', 'q', 0x2f],
    ['KeyM', 'm', 0x25],
    ['Digit1', '1', 0x1f],
    ['Digit0', '0', 0x32],
    ['Digit7', '7', 0x33],
  ])('%s maps to $%s', (code, value, expected) => {
    const mapped = mapAtariKey(key(code, value));
    expect(mapped?.code).toBe(expected);
    expect(mapped?.shift).toBe(false);
  });

  it('uses the host Shift state for letter case and the shifted number row', () => {
    expect(mapAtariKey(key('KeyA', 'A', true))?.shift).toBe(true);
    const bang = mapAtariKey(key('Digit1', '!', true));
    expect(bang).toEqual({ code: 0x1f, shift: true, control: false });
  });
});

describe('atari keyboard symbols', () => {
  it('maps legends to the physical key and the shift the Atari needs', () => {
    // The Atari has a dedicated unshifted + key, so typing + must not assert
    // Shift (that would produce backslash on the shifted table).
    expect(mapAtariKey(key('Equal', '+', true))).toEqual({ code: 0x06, shift: false, control: false });
    expect(mapAtariKey(key('Equal', '=', false))).toEqual({ code: 0x0f, shift: false, control: false });
    expect(mapAtariKey(key('Minus', '_', true))?.code).toBe(0x0e);
    expect(mapAtariKey(key('Minus', '_', true))?.shift).toBe(true);
    expect(mapAtariKey(key('Semicolon', ':', true))).toEqual({ code: 0x02, shift: true, control: false });
    expect(mapAtariKey(key('Comma', '[', true))).toEqual({ code: 0x20, shift: true, control: false });
    expect(mapAtariKey(key('Period', ']', true))).toEqual({ code: 0x22, shift: true, control: false });
    expect(mapAtariKey(key('Comma', ',', false))?.code).toBe(0x20);
    expect(mapAtariKey(key('Slash', '?', true))?.code).toBe(0x26);
    expect(mapAtariKey(key('Backslash', '\\', true))).toEqual({ code: 0x06, shift: true, control: false });
    expect(mapAtariKey(key('Key8', '@', true))?.code).toBe(0x35);
    expect(mapAtariKey(key('BracketLeft', '}', true))?.code).toBe(0x36);
  });

  it('maps the special keys to their scan codes', () => {
    expect(mapAtariKey(key('Enter', 'Enter'))?.code).toBe(0x0c);
    expect(mapAtariKey(key('Escape', 'Escape'))?.code).toBe(0x1c);
    expect(mapAtariKey(key('Backspace', 'Backspace'))?.code).toBe(0x34);
    expect(mapAtariKey(key('Tab', 'Tab'))?.code).toBe(0x2c);
    expect(mapAtariKey(key('Space', ' '))?.code).toBe(0x21);
    expect(mapAtariKey(key('CapsLock', 'CapsLock'))?.code).toBe(0x3c);
    expect(mapAtariKey(key('F1', 'F1'))?.code).toBe(0x03);
    expect(mapAtariKey(key('F5', 'F5'))?.code).toBe(0x11); // HELP
    expect(mapAtariKey(key('F6', 'F6'))?.code).toBe(0x11); // HELP
    expect(mapAtariKey(key('Insert', 'Insert'))?.code).toBe(0x27); // INV
  });

  it('sends the cursor keys as CTRL combinations', () => {
    expect(mapAtariKey(key('ArrowUp', 'ArrowUp'))).toEqual({ code: 0x0e, shift: false, control: true });
    expect(mapAtariKey(key('ArrowDown', 'ArrowDown'))).toEqual({ code: 0x0f, shift: false, control: true });
    expect(mapAtariKey(key('ArrowLeft', 'ArrowLeft'))).toEqual({ code: 0x06, shift: false, control: true });
    expect(mapAtariKey(key('ArrowRight', 'ArrowRight'))).toEqual({ code: 0x07, shift: false, control: true });
  });

  it('leaves F2-F4 to the console keys (START, SELECT, OPTION), off the matrix', () => {
    expect(CONSOLE_KEYS).toEqual({ F2: 0x01, F3: 0x02, F4: 0x04 });
    expect(mapAtariKey(key('F2', 'F2'))).toBeNull();
    expect(mapAtariKey(key('F4', 'F4'))).toBeNull();
  });

  it('rejects keys the Atari has no equivalent for', () => {
    expect(mapAtariKey(key('F13', 'F13'))).toBeNull();
    expect(mapAtariKey(key('Backquote', '`'))).toBeNull();
  });

  it('recognises bare modifiers', () => {
    expect(isModifierKey('ShiftLeft')).toBe(true);
    expect(isModifierKey('ControlRight')).toBe(true);
    expect(isModifierKey('KeyA')).toBe(false);
  });
});
