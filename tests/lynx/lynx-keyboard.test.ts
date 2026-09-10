/**
 * The Lynx matrix, checked against MAME's camplynx.cpp LINE0-LINE9. The lines
 * are addressed by A8-A11 of a port read rather than selected by a write, so
 * this class is a plain ten-line array with no select state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxKeyboard } from '@/machines/lynx/lynx-keyboard.ts';

describe('Lynx keyboard matrix', () => {
  let kb: LynxKeyboard;
  beforeEach(() => { kb = new LynxKeyboard(); });

  it('reads every line idle until a key goes down', () => {
    for (let line = 0; line < 10; line++) expect(kb.read(line)).toBe(0xFF);
  });

  it('pulls the pressed key\'s bit low and leaves the rest of the line alone', () => {
    kb.setKey(2, 5, true);                       // A
    expect(kb.read(2)).toBe(0xFF & ~0x20);
    expect(kb.read(1)).toBe(0xFF);
    kb.setKey(2, 5, false);
    expect(kb.read(2)).toBe(0xFF);
  });

  it('puts the host keys where the Lynx keeps them', () => {
    // The Lynx's numbers are scattered: 1 is alone on line 0, 2 is on line 2,
    // 3 and 4 share line 1. Getting these wrong types the wrong digit.
    const at = (code: string, line: number, bit: number) => {
      expect(kb.handleKeyEvent(code, true), code).toBe(true);
      expect(kb.read(line), code).toBe(0xFF & ~(1 << bit));
      kb.handleKeyEvent(code, false);
    };
    at('Digit1', 0, 0);
    at('Digit2', 2, 0);
    at('Digit3', 1, 0);
    at('Digit4', 1, 1);
    at('KeyQ', 2, 1);
    at('KeyZ', 2, 3);
    at('Space', 4, 3);
    at('Enter', 9, 3);
    at('Escape', 0, 6);   // the Lynx's BREAK
  });

  it('shares one cell between the two shifts and the two controls', () => {
    kb.handleKeyEvent('ShiftLeft', true);
    kb.handleKeyEvent('ShiftRight', true);
    expect(kb.read(0)).toBe(0xFF & ~0x80);
    kb.handleKeyEvent('ControlLeft', true);
    expect(kb.read(2)).toBe(0xFF & ~0x40);
  });

  it('leaves function keys unmapped — the Lynx has none', () => {
    for (const code of ['F1', 'F5', 'F10']) {
      expect(kb.handleKeyEvent(code, true), code).toBe(false);
    }
  });

  it('reads outside the ten lines as idle rather than throwing', () => {
    expect(kb.read(-1)).toBe(0xFF);
    expect(kb.read(10)).toBe(0xFF);
    kb.setKey(10, 0, true);
    expect(kb.read(10)).toBe(0xFF);
  });

  it('releases everything on reset', () => {
    kb.setKey(0, 7, true);
    kb.setKey(9, 3, true);
    kb.reset();
    expect(kb.read(0)).toBe(0xFF);
    expect(kb.read(9)).toBe(0xFF);
  });
});
