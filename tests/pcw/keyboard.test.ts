/**
 * PCW keyboard tests.
 *
 * Positions are taken from the Amstrad PCW Hardware Reference's matrix table,
 * which lists each byte's bits from b7 down to b0 — e.g. &3FF8 is
 * "Z lock A tab Q stop 2 1", so Z is b7 of &3FF8 and '1' is b0.
 *
 * The matrix is ACTIVE HIGH: a pressed key sets its bit, and an idle matrix is
 * all zeros. The CP/M Plus XBIOS settles it — its scan loop takes a key as
 * newly pressed on a 0 -> 1 edge (`LD A,(HL) / CPL / AND C`), so an all-ones
 * idle matrix makes it type eight phantom keys at its own prompt.
 */

import { describe, expect, it } from 'vitest';
import { PcwKeyboard } from '@/machines/pcw/pcw-keyboard.ts';
import { PCW_KEYBOARD_OFFSET } from '@/machines/pcw/constants.ts';

function key(code: string) {
  return { code, key: code, shift: false, ctrl: false, alt: false };
}

describe('PCW keyboard matrix', () => {
  it('puts each key in its documented byte and bit', () => {
    const kbd = new PcwKeyboard();
    const cases: [string, number, number][] = [
      ['KeyZ', 0x8, 7],     // &3FF8 b7
      ['Digit1', 0x8, 0],   // &3FF8 b0
      ['Space', 0x5, 7],    // &3FF5 b7
      ['Enter', 0x2, 2],    // &3FF2 b2 (RETURN)
      ['ShiftLeft', 0x2, 5],
      ['Backspace', 0x9, 7],// &3FF9 b7 (DEL<)
      ['ControlLeft', 0xA, 7], // &3FFA b7 (ALT — the PCW's control key)
    ];
    for (const [code, byte, bit] of cases) {
      kbd.reset();
      expect(kbd.matrix[byte] & (1 << bit), `${code} idle`).toBe(0);
      kbd.handleKeyEvent(key(code), true);
      expect(kbd.matrix[byte] & (1 << bit), `${code} down`).not.toBe(0);
      // Nothing else may move — the plain key bytes stay fully idle. The last
      // four carry link and transmit flags, so they are checked separately.
      const others = Array.from(kbd.matrix)
        .filter((_, i) => i !== byte && i < 0x0C);
      expect(others.every(b => b === 0x00), `${code} disturbed another byte`).toBe(true);
      kbd.handleKeyEvent(key(code), false);
      expect(kbd.matrix[byte] & (1 << bit), `${code} up`).toBe(0);
    }
  });

  it('ignores keys the PCW has not got', () => {
    const kbd = new PcwKeyboard();
    expect(kbd.handleKeyEvent(key('F13'), true)).toBe(false);
    expect(kbd.anyKeyDown).toBe(false);
  });

  it('survives a repeated key-down without losing the release', () => {
    // Browsers auto-repeat key-down; a naive toggle would leave the key stuck.
    const kbd = new PcwKeyboard();
    kbd.handleKeyEvent(key('KeyA'), true);
    kbd.handleKeyEvent(key('KeyA'), true);
    kbd.handleKeyEvent(key('KeyA'), false);
    expect(kbd.matrix[0x8] & (1 << 5)).toBe(0);
    expect(kbd.anyKeyDown).toBe(false);
  });

  it('keeps &3FFD b7 set and mirrors SHIFT LOCK in b6', () => {
    const kbd = new PcwKeyboard();
    expect(kbd.matrix[0x0D] & 0x80).toBe(0x80);
    expect(kbd.matrix[0x0D] & 0x40).toBe(0);
    kbd.handleKeyEvent(key('CapsLock'), true);
    expect(kbd.matrix[0x0D] & 0x40).toBe(0x40);
    kbd.handleKeyEvent(key('CapsLock'), false);
    kbd.handleKeyEvent(key('CapsLock'), true);
    expect(kbd.matrix[0x0D] & 0x40).toBe(0);
  });

  it('writes the matrix into block 3 at &3FF0', () => {
    const kbd = new PcwKeyboard();
    kbd.handleKeyEvent(key('KeyQ'), true);   // &3FF8 b3
    const block = new Uint8Array(0x4000);
    kbd.writeInto(block, PCW_KEYBOARD_OFFSET);
    expect(block[0x3FF8] & (1 << 3)).not.toBe(0);   // pressed sets the bit
    expect(block[0x3FEF]).toBe(0);           // nothing written below &3FF0
    expect(block[0x3FFD] & 0x80).toBe(0x80);
  });

  it('idles as all zeros, so the XBIOS sees no key go down at boot', () => {
    const kbd = new PcwKeyboard();
    for (let i = 0; i < 0x0C; i++) {
      expect(kbd.matrix[i], `byte ${i.toString(16)}`).toBe(0x00);
    }
  });

  it('reports no option links fitted in &3FFE', () => {
    // b6 is LK1, which would put the keyboard into self-test and make the BIOS
    // disregard it; b7 is LK3. Both are disconnected on a stock machine.
    const kbd = new PcwKeyboard();
    const block = new Uint8Array(0x4000);
    kbd.writeInto(block, PCW_KEYBOARD_OFFSET);
    expect(block[0x3FFE] & 0x40).toBe(0);
    expect(block[0x3FFE] & 0x80).toBe(0);
  });

  it('toggles &3FFF b6 on every scan, as the keyboard heartbeat', () => {
    const kbd = new PcwKeyboard();
    const block = new Uint8Array(0x4000);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      kbd.writeInto(block, PCW_KEYBOARD_OFFSET);
      seen.push(block[0x3FFF] & 0x40);
    }
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[1]).not.toBe(seen[2]);
    expect(seen[0]).toBe(seen[2]);
    expect(seen[1]).toBe(seen[3]);
  });
});
