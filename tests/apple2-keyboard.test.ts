/**
 * Apple II keyboard: the ][ encoder's per-cap codes (as the on-screen keyboard
 * types them), physical-key release, and the RESET key on each family.
 *
 * Expected codes are from the Apple II Reference Manual's keyboard table: the
 * ][ prints its own shift pairs (SHIFT-2 is ", not @), SHIFT-0 is still 0, only
 * N, M and P change with SHIFT (^ ] @), and CTRL affects letters alone.
 */

import { describe, it, expect } from 'vitest';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';
import { Apple2Keyboard, apple2FaceByte } from '@/machines/apple2/apple2-keyboard.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

const ev = (code: string, key: string, shift = false, ctrl = false): HostKeyEvent =>
  ({ code, key, shift, ctrl, alt: false });

describe('apple ][ encoder caps', () => {
  it('uses the ][ shift pairs, not the PC ones', () => {
    expect(apple2FaceByte('Digit2', true, false)).toBe(0x22);   // "
    expect(apple2FaceByte('Digit6', true, false)).toBe(0x26);   // &
    expect(apple2FaceByte('Digit7', true, false)).toBe(0x27);   // '
    expect(apple2FaceByte('Digit0', true, false)).toBe(0x30);   // SHIFT-0 is still 0
    expect(apple2FaceByte('colon', false, false)).toBe(0x3A);
    expect(apple2FaceByte('colon', true, false)).toBe(0x2A);    // *
    expect(apple2FaceByte('Minus', true, false)).toBe(0x3D);    // =
    expect(apple2FaceByte('Semicolon', true, false)).toBe(0x2B); // +
  });

  it('shifts only N, M and P among the letters', () => {
    expect(apple2FaceByte('KeyN', true, false)).toBe(0x5E);     // ^
    expect(apple2FaceByte('KeyM', true, false)).toBe(0x5D);     // ]
    expect(apple2FaceByte('KeyP', true, false)).toBe(0x40);     // @
    expect(apple2FaceByte('KeyA', true, false)).toBe(0x41);     // no lower case
  });

  it('applies CTRL to letters only, including the shifted three', () => {
    expect(apple2FaceByte('KeyG', false, true)).toBe(0x07);     // BELL
    expect(apple2FaceByte('KeyM', true, true)).toBe(0x1D);
    expect(apple2FaceByte('KeyN', true, true)).toBe(0x1E);
    expect(apple2FaceByte('KeyP', true, true)).toBe(0x00);
    expect(apple2FaceByte('Digit1', false, true)).toBe(0x31);
  });

  it('sends the arrows as Ctrl-H and Ctrl-U', () => {
    expect(apple2FaceByte('ArrowLeft', false, false)).toBe(0x08);
    expect(apple2FaceByte('ArrowRight', false, false)).toBe(0x15);
    expect(apple2FaceByte('Delete', false, false)).toBeNull();  // no such cap on the ][
  });
});

describe('apple2 keyboard key tracking', () => {
  it('releases a //e key even when SHIFT changed while it was down', () => {
    const kb = new Apple2Keyboard(true);
    kb.toggleCapsLock();                                       // caps off: SHIFT matters
    kb.handleEvent(ev('ShiftLeft', 'Shift', true), true);
    kb.handleEvent(ev('KeyA', 'A', true), true);
    expect(kb.readData()).toBe(0x80 | 0x41);
    kb.handleEvent(ev('ShiftLeft', 'Shift'), false);
    kb.handleEvent(ev('KeyA', 'a'), false);                    // would encode as 'a' now
    expect(kb.anyPressed).toBe(false);
  });

  it('reads SHIFT as //e button 2 but not as a key', () => {
    const kb = new Apple2Keyboard(true);
    kb.handleEvent(ev('ShiftLeft', 'Shift', true), true);
    expect(kb.button(2)).toBe(true);
    expect(kb.anyPressed).toBe(false);
  });

  it('latches the last key again on REPT', () => {
    const kb = new Apple2Keyboard(false);
    kb.setKey(0x41, true);
    kb.clearStrobe();
    kb.repeat();
    expect(kb.readData()).toBe(0xC1);
  });
});

describe('apple2 RESET key', () => {
  /** A 12K ][+ ROM that loops at $D000, with the reset vector pointing there. */
  function loopRom(): Uint8Array {
    const rom = new Uint8Array(0x3000);
    rom.set([0x4C, 0x00, 0xD0], 0);
    rom[0x2FFC] = 0x00;
    rom[0x2FFD] = 0xD0;
    return rom;
  }

  it('pulls the ][+ CPU to its reset vector without clearing RAM', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      m.loadROM(loopRom());
      m.reset();
      m.memory.ram[0x300] = 0x5A;
      m.cpu.pc = 0x0300;
      expect(m.pressResetKey()).toBe(true);
      expect(m.cpu.pc).toBe(0xD000);
      expect(m.memory.ram[0x300]).toBe(0x5A);
    } finally {
      m.destroy();
    }
  });

  it('needs CTRL held on the //e', () => {
    const m = new Apple2Machine('apple2e', null);
    try {
      m.cpu.pc = 0x0300;
      expect(m.pressResetKey()).toBe(false);
      expect(m.cpu.pc).toBe(0x0300);
      m.keyboard.handleEvent(ev('ControlLeft', 'Control', false, true), true);
      expect(m.pressResetKey()).toBe(true);
    } finally {
      m.destroy();
    }
  });
});
