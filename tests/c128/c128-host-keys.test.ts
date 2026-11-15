/**
 * The host keys that press the 128's three extra keyboard lines. In 128 mode the
 * four arrows, TAB and the numeric keypad are their own keys (a program that
 * reads the dedicated cursor keys, or the SHIFT state, must see them clean); in
 * 64 mode the 64's mapping stays (the cursor keys plus SHIFT, TAB as CTRL),
 * because that KERNAL never scans those lines.
 */

import { describe, it, expect } from 'vitest';
import { C128Keyboard } from '@/machines/c128/keyboard.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

const ev = (code: string, key = ''): HostKeyEvent => ({ code, key, shift: false, ctrl: false, alt: false } as HostKeyEvent);

function keyboard(c64: boolean): C128Keyboard {
  const k = new C128Keyboard();
  k.isC64Mode = () => c64;
  return k;
}

describe('host keys in 128 mode', () => {
  it('presses the arrows as the K2 cursor keys, with no SHIFT', () => {
    const k = keyboard(false);
    for (const [code, key] of [['ArrowUp', 'up'], ['ArrowDown', 'down'], ['ArrowLeft', 'left'], ['ArrowRight', 'right']] as const) {
      k.handleEvent(ev(code), true);
      expect(k.isPressed(key), code).toBe(true);
      expect(k.isPressed('lshift'), `${code} leaves SHIFT alone`).toBe(false);
      expect(k.isPressed('crsr-ud') || k.isPressed('crsr-lr')).toBe(false);
      k.handleEvent(ev(code), false);
      expect(k.isPressed(key)).toBe(false);
    }
  });

  it('presses the keypad cells, KP ENTER included, and TAB and LINE FEED', () => {
    const k = keyboard(false);
    const pairs: [string, string][] = [
      ['Numpad0', 'kp0'], ['Numpad5', 'kp5'], ['Numpad9', 'kp9'], ['NumpadDecimal', 'kp.'],
      ['NumpadAdd', 'kp+'], ['NumpadSubtract', 'kp-'], ['NumpadEnter', 'kp-enter'], ['Tab', 'tab'], ['PageDown', 'linefeed'],
    ];
    for (const [code, key] of pairs) {
      k.handleEvent(ev(code, code.startsWith('Numpad') ? '5' : ''), true);
      expect(k.isPressed(key), code).toBe(true);
      k.handleEvent(ev(code), false);
      expect(k.isPressed(key)).toBe(false);
    }
    expect(k.isPressed('return'), 'KP ENTER is not the main RETURN').toBe(false);
  });

  it('lets go of the key it pressed even if the mode changed in between', () => {
    let c64 = false;
    const k = new C128Keyboard();
    k.isC64Mode = () => c64;
    k.handleEvent(ev('ArrowUp'), true);
    c64 = true;
    k.handleEvent(ev('ArrowUp'), false);
    expect(k.isPressed('up')).toBe(false);
  });
});

describe('host keys in 64 mode', () => {
  it('keeps the 64\'s mapping: the cursor keys with SHIFT, TAB as CTRL, the keypad typing its character', () => {
    const k = keyboard(true);
    k.handleEvent(ev('ArrowUp'), true);
    expect(k.isPressed('crsr-ud')).toBe(true);
    expect(k.isPressed('lshift')).toBe(true);
    expect(k.isPressed('up')).toBe(false);
    k.handleEvent(ev('ArrowUp'), false);
    k.handleEvent(ev('Tab'), true);
    expect(k.isPressed('ctrl')).toBe(true);
    expect(k.isPressed('tab')).toBe(false);
    k.handleEvent(ev('Tab'), false);
    k.handleEvent(ev('Numpad5', '5'), true);
    expect(k.isPressed('5')).toBe(true);
    expect(k.isPressed('kp5')).toBe(false);
  });
});
