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

/**
 * The extended keyboard bytes and the keys with no cap on a host keyboard.
 *
 * Expected cells are transcribed from John Elliott's PCW hardware guide §10
 * (the key table, and the notes on &3FFC-&3FFF), not read back from the
 * implementation: "3FFEh maps ASDFGHJ to up, ZXCVBNM to down, QEO[L</, to
 * left, WRP];>.1/2 to right, Space to Fire 1, Shift to Fire 2", "3FFFh maps
 * HJKL;<> to up, BNM,./1/2 to down, QEO[ADZC to left, WRP[SFXV to right",
 * "3FFDh maps to the numeric keypad", "3FFCh gives an inverted T pattern
 * centred on F1".
 */
describe('PCW extended keyboard bytes (&3FFC-&3FFF)', () => {
  /** The bytes &3FFC-&3FFF with `code` held. */
  function held(...codes: string[]): number[] {
    const kbd = new PcwKeyboard();
    for (const c of codes) kbd.handleKeyEvent(key(c), true);
    return Array.from(kbd.matrix.subarray(0xC, 0x10));
  }
  const idle = held();

  it('idles with only the fixed status bits set', () => {
    // &3FFD b7 is ~LK2 (set: LK2 not fitted); the rest read 0.
    expect(idle).toEqual([0x00, 0x80, 0x00, 0x00]);
  });

  it('reports Space as fire 1 in every joystick byte', () => {
    const [c, d, e, f] = held('Space');
    expect(c & 0x10).toBe(0x10);   // &3FFC b4 (Space)
    expect(d & 0x20).toBe(0x20);   // &3FFD b5
    expect(e & 0x10).toBe(0x10);   // &3FFE b4
    expect(f & 0x10).toBe(0x10);   // &3FFF b4
  });

  it('reports Shift as fire 2 in &3FFE and &3FFF', () => {
    const [, , e, f] = held('ShiftLeft');
    expect(e & 0x20).toBe(0x20);
    expect(f & 0x20).toBe(0x20);
  });

  it('gives the pad cursor keys in &3FFD b0-b3', () => {
    // kp5 up b0, kp. down b1, kp1 left b2, kp3 right b3 (and kp2 b4, per the guide).
    expect(held('Numpad5')[1] & 0x0F).toBe(0x01);
    expect(held('NumpadDecimal')[1] & 0x0F).toBe(0x02);
    expect(held('Numpad1')[1] & 0x0F).toBe(0x04);
    expect(held('Numpad3')[1] & 0x0F).toBe(0x08);
    expect(held('Numpad2')[1] & 0x10).toBe(0x10);
  });

  it('draws the inverted T round F1 in &3FFC', () => {
    expect(held('F1')[0] & 0x3F).toBe(0x02);        // b1 f1/f2
    expect(held('F3')[0] & 0x3F).toBe(0x01);        // b0 f3/f4
    expect(held('End')[0] & 0x3F).toBe(0x04);       // b2 EXIT
    expect(held('Numpad0')[0] & 0x3F).toBe(0x08);   // b3 kp0
    expect(held('NumpadEnter')[0] & 0x3F).toBe(0x20); // b5 kp ENTER
  });

  it('groups the letter keys into the &3FFE and &3FFF directions', () => {
    // [key, &3FFE bit, &3FFF bit] — null where the guide's group has no such key.
    const cases: [string, number | null, number | null][] = [
      ['KeyA', 0, 2],   // ASDFGHJ up; QEO[ADZC left
      ['KeyH', 0, 0],   // ASDFGHJ up; HJKL;<> up
      ['KeyZ', 1, 2],   // ZXCVBNM down; QEO[ADZC left
      ['KeyB', 1, 1],   // ZXCVBNM down; BNM,./1/2 down
      ['KeyQ', 2, 2],   // QEO[L</, left; QEO[ADZC left
      ['KeyW', 3, 3],   // WRP];>.1/2 right; WRP[SFXV right
      ['KeyS', 0, 3],   // ASDFGHJ up; WRP[SFXV right
      ['KeyL', 2, 0],   // QEO[L</, left; HJKL;<> up
      ['Comma', 2, 1],  // QEO[L</, left; BNM,./1/2 down
      ['Backquote', 3, 1], // 1/2: WRP];>.1/2 right; BNM,./1/2 down
    ];
    for (const [code, eBit, fBit] of cases) {
      const [, , e, f] = held(code);
      expect(e & 0x0F, `${code} in &3FFE`).toBe(eBit === null ? 0 : 1 << eBit);
      expect(f & 0x0F, `${code} in &3FFF`).toBe(fBit === null ? 0 : 1 << fBit);
    }
  });

  it('keeps a group bit up while any key in it is still held', () => {
    const kbd = new PcwKeyboard();
    kbd.handleKeyEvent(key('KeyA'), true);
    kbd.handleKeyEvent(key('KeyS'), true);
    kbd.handleKeyEvent(key('KeyA'), false);
    expect(kbd.matrix[0xE] & 0x01).toBe(0x01);   // S still holds ASDFGHJ
    kbd.handleKeyEvent(key('KeyS'), false);
    expect(kbd.matrix[0xE] & 0x01).toBe(0);
  });
});

describe('PCW host key mapping', () => {
  const down = (code: string): [number, number][] => {
    const kbd = new PcwKeyboard();
    kbd.handleKeyEvent(key(code), true);
    const out: [number, number][] = [];
    for (let b = 0; b < 0x0C; b++) for (let bit = 7; bit >= 0; bit--) if (kbd.matrix[b] & (1 << bit)) out.push([b, bit]);
    return out.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  };

  it('maps the cursor keys to the pad caps that carry the arrows', () => {
    expect(down('ArrowUp')).toEqual([[0x1, 6]]);      // kp5, &3FF1 b6
    expect(down('ArrowLeft')).toEqual([[0x1, 7]]);    // kp1, &3FF1 b7
    expect(down('ArrowRight')).toEqual([[0x0, 6]]);   // kp3, &3FF0 b6
    expect(down('ArrowDown')).toEqual([[0xA, 6]]);    // kp., &3FFA b6
  });

  it('maps f1-f8 onto the four function caps, SHIFT choosing the higher of each pair', () => {
    // f1/f2 &3FF0 b2, f3/f4 &3FF0 b0, f5/f6 &3FFA b0, f7/f8 &3FFA b4.
    expect(down('F1')).toEqual([[0x0, 2]]);
    expect(down('F2')).toEqual([[0x0, 2], [0x2, 5]]);
    expect(down('F3')).toEqual([[0x0, 0]]);
    expect(down('F4')).toEqual([[0x0, 0], [0x2, 5]]);
    expect(down('F5')).toEqual([[0xA, 0]]);
    expect(down('F6')).toEqual([[0x2, 5], [0xA, 0]]);
    expect(down('F7')).toEqual([[0xA, 4]]);
    expect(down('F8')).toEqual([[0x2, 5], [0xA, 4]]);
  });

  it('maps the editing caps PTR, EXIT, CUT, COPY, PASTE and CAN', () => {
    expect(down('Home')).toEqual([[0x1, 1]]);     // PTR   &3FF1 b1
    expect(down('End')).toEqual([[0x1, 0]]);      // EXIT  &3FF1 b0
    expect(down('F9')).toEqual([[0x1, 2]]);       // CUT   &3FF1 b2
    expect(down('F10')).toEqual([[0x1, 3]]);      // COPY  &3FF1 b3
    expect(down('Insert')).toEqual([[0x0, 3]]);   // PASTE &3FF0 b3
    expect(down('Pause')).toEqual([[0xA, 2]]);    // CAN   &3FFA b2
    expect(down('PageUp')).toEqual([[0x2, 7]]);   // [+]   &3FF2 b7
    expect(down('PageDown')).toEqual([[0xA, 3]]); // [-]   &3FFA b3
  });

  it('does not release a shared cap until its last key is up', () => {
    // Both SHIFT keys, and F2 (which presses SHIFT) with a real SHIFT.
    const kbd = new PcwKeyboard();
    kbd.handleKeyEvent(key('ShiftLeft'), true);
    kbd.handleKeyEvent(key('F2'), true);
    kbd.handleKeyEvent(key('ShiftLeft'), false);
    expect(kbd.isCellDown([0x2, 5])).toBe(true);     // F2 still presses it
    kbd.handleKeyEvent(key('F2'), false);
    expect(kbd.isCellDown([0x2, 5])).toBe(false);
    expect(kbd.isCellDown([0x0, 2])).toBe(false);
  });
});
