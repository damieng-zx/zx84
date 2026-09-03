/**
 * SAM Coupé keyboard, joystick and memory contention.
 *
 * The keyboard matrix is nine rows of eight active-low bits. Bits 0-4 of a row
 * are read through port 0xFE (the Spectrum's half-row convention — and the
 * first five columns really are the Spectrum's own layout), while bits 5-7
 * carry the SAM's extra keys and come back in the top three bits of port 0xF9.
 * Row 8 (CNTRL and the cursor keys) is selected only when the port's high byte
 * is 0xFF, i.e. when no ordinary row is selected, and is unreachable via 0xF9.
 *
 * Expectations are written from that matrix definition rather than from the
 * lookup table in the implementation, so a transposed entry shows up here.
 */

import { describe, expect, it } from 'vitest';
import { SamKeyboard } from '@/machines/sam/sam-keyboard.ts';
import { SamJoystick } from '@/machines/sam/sam-joystick.ts';
import { SamContention } from '@/machines/sam/contention.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';
import {
  SAM_DISPLAY_FIRST_CELL, SAM_DISPLAY_FIRST_LINE, SAM_DISPLAY_LAST_LINE,
  SAM_T_PER_CELL,
} from '@/machines/sam/constants.ts';

const ev = (code: string): HostKeyEvent =>
  ({ code, key: '', shift: false, ctrl: false, alt: false });

/** Port high byte that selects exactly one row (active low). */
const selectRow = (row: number) => (~(1 << row)) & 0xFF;

describe('SamKeyboard matrix', () => {
  it('reads all ones when nothing is pressed', () => {
    const k = new SamKeyboard();
    for (let row = 0; row < 8; row++) {
      expect(k.readLow(selectRow(row))).toBe(0x1F);
      expect(k.readHigh(selectRow(row))).toBe(0xE0);
    }
    expect(k.readLow(0xFF)).toBe(0x1F);
  });

  it('pulls the right bit low for each Spectrum-layout row', () => {
    // Row 0 bit 1 is Z, row 6 bit 0 is RETURN, row 7 bit 0 is SPACE.
    const cases: [string, number, number][] = [
      ['KeyZ', 0, 1], ['KeyV', 0, 4],
      ['KeyA', 1, 0], ['KeyG', 1, 4],
      ['KeyQ', 2, 0], ['KeyT', 2, 4],
      ['Digit1', 3, 0], ['Digit5', 3, 4],
      ['Digit0', 4, 0], ['Digit6', 4, 4],
      ['KeyP', 5, 0], ['KeyY', 5, 4],
      ['Enter', 6, 0], ['KeyH', 6, 4],
      ['Space', 7, 0], ['KeyB', 7, 4],
    ];
    for (const [code, row, bit] of cases) {
      const k = new SamKeyboard();
      k.handleKeyEvent(ev(code), true);
      expect(k.readLow(selectRow(row))).toBe(0x1F & ~(1 << bit));
      // ...and no other row is disturbed.
      expect(k.readLow(selectRow((row + 1) % 8))).toBe(0x1F);
    }
  });

  it('puts SHIFT on row 0 bit 0 and SYMBOL on row 7 bit 1', () => {
    // The two shift-like keys the Spectrum layout defines.
    const k = new SamKeyboard();
    k.handleKeyEvent(ev('ShiftLeft'), true);
    expect(k.readLow(selectRow(0)) & 0x01).toBe(0);

    k.handleKeyEvent(ev('ControlLeft'), true);
    expect(k.readLow(selectRow(7)) & 0x02).toBe(0);
  });

  it('ANDs every selected row together, so chords across rows read correctly', () => {
    // SHIFT (row 0 bit 0) with A (row 1 bit 0), both rows selected at once.
    const k = new SamKeyboard();
    k.handleKeyEvent(ev('ShiftLeft'), true);
    k.handleKeyEvent(ev('KeyA'), true);
    const both = (~((1 << 0) | (1 << 1))) & 0xFF;
    expect(k.readLow(both)).toBe(0x1F & ~0x01);
    // Each row alone shows only its own key.
    expect(k.readLow(selectRow(0))).toBe(0x1F & ~0x01);
    expect(k.readLow(selectRow(1))).toBe(0x1F & ~0x01);
  });

  it('releases keys again', () => {
    const k = new SamKeyboard();
    k.handleKeyEvent(ev('KeyZ'), true);
    expect(k.readLow(selectRow(0))).not.toBe(0x1F);
    k.handleKeyEvent(ev('KeyZ'), false);
    expect(k.readLow(selectRow(0))).toBe(0x1F);
  });

  it('declines a key the SAM has not got', () => {
    const k = new SamKeyboard();
    expect(k.handleKeyEvent(ev('F13'), true)).toBe(false);
    expect(k.handleKeyEvent(ev('KeyZ'), true)).toBe(true);
  });
});

describe('SamKeyboard extra keys on port 0xF9', () => {
  it('returns the function keys in the top three bits', () => {
    // Rows 0/1/2 bits 5-7 are F1-F9, in order.
    const cases: [string, number, number][] = [
      ['F1', 0, 5], ['F2', 0, 6], ['F3', 0, 7],
      ['F4', 1, 5], ['F5', 1, 6], ['F6', 1, 7],
      ['F7', 2, 5], ['F8', 2, 6], ['F9', 2, 7],
    ];
    for (const [code, row, bit] of cases) {
      const k = new SamKeyboard();
      k.handleKeyEvent(ev(code), true);
      expect(k.readHigh(selectRow(row))).toBe(0xE0 & ~(1 << bit));
      // An extra key must not disturb the low five bits.
      expect(k.readLow(selectRow(row))).toBe(0x1F);
    }
  });

  it('places ESCAPE, TAB and CAPS on row 3, and DELETE on row 4', () => {
    const cases: [string, number, number][] = [
      ['Escape', 3, 5], ['Tab', 3, 6], ['CapsLock', 3, 7],
      ['Backspace', 4, 7], ['F10', 5, 7], ['Insert', 7, 7],
    ];
    for (const [code, row, bit] of cases) {
      const k = new SamKeyboard();
      k.handleKeyEvent(ev(code), true);
      expect(k.readHigh(selectRow(row))).toBe(0xE0 & ~(1 << bit));
    }
  });

  it('keeps the extra keys out of the port 0xFE read', () => {
    const k = new SamKeyboard();
    k.handleKeyEvent(ev('F1'), true);
    k.handleKeyEvent(ev('Escape'), true);
    expect(k.readLow(selectRow(0))).toBe(0x1F);
    expect(k.readLow(selectRow(3))).toBe(0x1F);
  });
});

describe('SamKeyboard ninth row', () => {
  it('answers port 0xFE only when no ordinary row is selected', () => {
    // The cursor keys and CNTRL cost no address line: they are read when the
    // high byte is 0xFF, which on a Spectrum would mean "no keys at all".
    const k = new SamKeyboard();
    k.handleKeyEvent(ev('ArrowUp'), true);
    expect(k.readLow(0xFF)).toBe(0x1F & ~0x02);

    // Selecting any real row hides it again.
    for (let row = 0; row < 8; row++) {
      expect(k.readLow(selectRow(row))).toBe(0x1F);
    }
  });

  it('lays out CNTRL and the four cursor keys in bits 0-4', () => {
    const cases: [string, number][] = [
      ['ControlRight', 0], ['ArrowUp', 1], ['ArrowDown', 2],
      ['ArrowLeft', 3], ['ArrowRight', 4],
    ];
    for (const [code, bit] of cases) {
      const k = new SamKeyboard();
      k.handleKeyEvent(ev(code), true);
      expect(k.readLow(0xFF)).toBe(0x1F & ~(1 << bit));
    }
  });

  it('is unreachable through port 0xF9', () => {
    const k = new SamKeyboard();
    k.handleKeyEvent(ev('ArrowUp'), true);
    k.handleKeyEvent(ev('ControlRight'), true);
    expect(k.readHigh(0xFF)).toBe(0xE0);
  });
});

describe('SamJoystick (Kempston, port 0x1F)', () => {
  it('reads 0xFF when idle', () => {
    expect(new SamJoystick().read()).toBe(0xFF);
  });

  it('pulls one bit low per direction', () => {
    const cases: [string, number][] = [
      ['right', 0], ['left', 1], ['down', 2], ['up', 3], ['fire', 4],
    ];
    for (const [dir, bit] of cases) {
      const j = new SamJoystick();
      j.set(dir, true);
      expect(j.read()).toBe(0xFF & ~(1 << bit));
    }
  });

  it('combines diagonals with fire', () => {
    const j = new SamJoystick();
    j.set('up', true);
    j.set('left', true);
    j.set('fire', true);
    expect(j.read()).toBe(0xFF & ~((1 << 3) | (1 << 1) | (1 << 4)));
  });

  it('ignores an unknown direction', () => {
    const j = new SamJoystick();
    j.set('sideways', true);
    expect(j.read()).toBe(0xFF);
  });
});

describe('SamContention', () => {
  /** A contention unit with the raster parked on a display line in mode 4. */
  function onDisplayLine(mode = 4): SamContention {
    const c = new SamContention();
    c.beginLine(SAM_DISPLAY_FIRST_LINE, 0, mode, false);
    return c;
  }

  it('uses 4 T-state slots off the display', () => {
    const c = new SamContention();
    c.beginLine(0, 0, 4, false);            // above the picture
    expect(c.slotFor(0)).toBe(4);
    c.beginLine(SAM_DISPLAY_LAST_LINE, 0, 4, false);   // below it
    expect(c.slotFor(0)).toBe(4);
  });

  it('uses 8 T-state slots across the display window', () => {
    const c = onDisplayLine();
    const inWindow = SAM_DISPLAY_FIRST_CELL * SAM_T_PER_CELL;
    expect(c.slotFor(inWindow)).toBe(8);
    // ...and 4 in the border either side of it.
    expect(c.slotFor(0)).toBe(4);
    expect(c.slotFor((SAM_DISPLAY_FIRST_CELL + 32) * SAM_T_PER_CELL)).toBe(4);
  });

  it('treats the whole field as border when the screen is off', () => {
    const c = new SamContention();
    c.beginLine(SAM_DISPLAY_FIRST_LINE, 0, 4, true);
    expect(c.slotFor(SAM_DISPLAY_FIRST_CELL * SAM_T_PER_CELL)).toBe(4);
  });

  it('rounds an instruction up to the slot, not each memory access', () => {
    // A 7 T-state LD A,(HL) costs 8 in the display area — the ~15% penalty
    // real code sees. Per *access* it would have cost around 21, a threefold
    // slowdown that no SAM exhibits.
    const c = onDisplayLine();
    const t = SAM_DISPLAY_FIRST_CELL * SAM_T_PER_CELL;
    expect(c.instructionDelay(t, 7)).toBe(1);
    expect(c.instructionDelay(t, 4)).toBe(4);
    expect(c.instructionDelay(t, 8)).toBe(0);
    expect(c.instructionDelay(t, 21)).toBe(3);
  });

  it('rounds to 4 over the border', () => {
    const c = onDisplayLine();
    expect(c.instructionDelay(0, 7)).toBe(1);
    expect(c.instructionDelay(0, 4)).toBe(0);
    expect(c.instructionDelay(0, 11)).toBe(1);
  });

  it('charges nothing when disabled', () => {
    const c = onDisplayLine();
    c.enabled = false;
    expect(c.instructionDelay(SAM_DISPLAY_FIRST_CELL * SAM_T_PER_CELL, 7)).toBe(0);
    expect(c.portDelay(1, 0xF8)).toBe(0);
  });

  it('gives the ASIC ports a wide slot wherever the raster is', () => {
    const c = new SamContention();
    c.beginLine(0, 0, 4, false);           // a border line
    expect(c.portDelay(1, 0x00F8)).toBe(7);
    expect(c.portDelay(8, 0x00FE)).toBe(0);
    // Ports outside 0xF8-0xFF are never delayed.
    expect(c.portDelay(1, 0x001F)).toBe(0);
    expect(c.portDelay(1, 0x00E0)).toBe(0);
  });

  it('measures the cell from the start of the line, not absolute time', () => {
    // The CPU overruns each line's budget slightly, so an absolute modulo
    // would drift out of phase with the raster across a field.
    const c = new SamContention();
    const lineStart = 123_457;
    c.beginLine(SAM_DISPLAY_FIRST_LINE, lineStart, 4, false);
    expect(c.slotFor(lineStart)).toBe(4);
    expect(c.slotFor(lineStart + SAM_DISPLAY_FIRST_CELL * SAM_T_PER_CELL)).toBe(8);
  });

  it('extends the display rule into alternate border groups in mode 1', () => {
    // The display window is cells 8-39, so the border cells are 0-7 (8-cell
    // group 0, even) and 40-47 (group 5, odd). Mode 1 widens the slot on the
    // even groups only.
    const leftBorder = 0;
    const rightBorder = 44 * SAM_T_PER_CELL;

    const mode1 = onDisplayLine(1);
    expect(mode1.slotFor(leftBorder)).toBe(8);
    expect(mode1.slotFor(rightBorder)).toBe(4);

    // Every other mode leaves both borders alone.
    const mode4 = onDisplayLine(4);
    expect(mode4.slotFor(leftBorder)).toBe(4);
    expect(mode4.slotFor(rightBorder)).toBe(4);
  });
});

describe('SamKeyboard punctuation', () => {
  it('puts COMMA and PERIOD on row 7 bits 5 and 6', () => {
    // Verified against the real ROM: pressing these two positions at the
    // BASIC prompt types "," and "." respectively.
    const comma = new SamKeyboard();
    comma.handleKeyEvent(ev('Comma'), true);
    expect(comma.readHigh(selectRow(7))).toBe(0xE0 & ~(1 << 5));

    const period = new SamKeyboard();
    period.handleKeyEvent(ev('Period'), true);
    expect(period.readHigh(selectRow(7))).toBe(0xE0 & ~(1 << 6));
  });

  it('binds a host key to every punctuation position', () => {
    // The nine slots columns 5-6 of rows 4-7 plus (6,7) are the SAM's
    // dedicated punctuation and edit keys; none should be left dead.
    const slots: [string, number, number][] = [
      ['Minus', 4, 5], ['Equal', 4, 6],
      ['BracketLeft', 5, 5], ['Quote', 5, 6],
      ['Semicolon', 6, 5], ['BracketRight', 6, 6], ['Home', 6, 7],
      ['Comma', 7, 5], ['Period', 7, 6],
    ];
    for (const [code, row, bit] of slots) {
      const k = new SamKeyboard();
      expect(k.handleKeyEvent(ev(code), true)).toBe(true);
      expect(k.readHigh(selectRow(row))).toBe(0xE0 & ~(1 << bit));
    }
  });
});
