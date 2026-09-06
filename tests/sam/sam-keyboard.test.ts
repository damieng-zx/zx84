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
  SAM_DISPLAY_FIRST_LINE, SAM_DISPLAY_FIRST_T, SAM_DISPLAY_LAST_LINE,
  SAM_T_PER_CELL,
} from '@/machines/sam/constants.ts';

const ev = (code: string): HostKeyEvent =>
  ({ code, key: '', shift: false, ctrl: false, alt: false });

/** A host event carrying the character a layout produced, as the browser does. */
const chr = (key: string, code = 'Unmapped', shift = false): HostKeyEvent =>
  ({ code, key, shift, ctrl: false, alt: false });

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
    // Measured in CPU time the fetch starts two side borders in and runs to
    // the end of the line: the beam lags the CPU's line boundary by one border,
    // so the raster's right border is already the next line's opening cells.
    const c = onDisplayLine();
    expect(c.slotFor(SAM_DISPLAY_FIRST_T)).toBe(8);
    expect(c.slotFor(SAM_DISPLAY_FIRST_T - SAM_T_PER_CELL)).toBe(4);
    expect(c.slotFor(47 * SAM_T_PER_CELL)).toBe(8);
    expect(c.slotFor(0)).toBe(4);
  });

  it('treats the whole field as border when the screen is off', () => {
    const c = new SamContention();
    c.beginLine(SAM_DISPLAY_FIRST_LINE, 0, 4, true);
    expect(c.slotFor(SAM_DISPLAY_FIRST_T)).toBe(4);
  });

  it('rounds an instruction up to the slot, not each memory access', () => {
    // A 7 T-state LD A,(HL) costs 8 in the display area — the ~15% penalty
    // real code sees. Per *access* it would have cost around 21, a threefold
    // slowdown that no SAM exhibits.
    const c = onDisplayLine();
    const t = SAM_DISPLAY_FIRST_T;
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
    expect(c.instructionDelay(SAM_DISPLAY_FIRST_T, 7)).toBe(0);
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
    expect(c.slotFor(lineStart + SAM_DISPLAY_FIRST_T)).toBe(8);
  });

  it('extends the display rule into alternate border groups in mode 1', () => {
    // In CPU time the border is the line's first sixteen cells: group 0 (cells
    // 0-7, the 0x40 bit clear) and group 1 (cells 8-15, set). Mode 1's
    // attribute fetch widens the slot on group 0 only.
    const firstGroup = 0;
    const secondGroup = 12 * SAM_T_PER_CELL;

    const mode1 = onDisplayLine(1);
    expect(mode1.slotFor(firstGroup)).toBe(8);
    expect(mode1.slotFor(secondGroup)).toBe(4);

    // Every other mode leaves both border groups alone.
    const mode4 = onDisplayLine(4);
    expect(mode4.slotFor(firstGroup)).toBe(4);
    expect(mode4.slotFor(secondGroup)).toBe(4);
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

  it('reaches every punctuation position from a typed character', () => {
    // Columns 5-6 of rows 4-7 are the SAM's dedicated punctuation keys, and
    // each is reached by typing the character it prints -- whatever the host
    // layout does to get there.
    const slots: [string, number, number][] = [
      ['-', 4, 5], ['+', 4, 6],
      ['=', 5, 5], ['"', 5, 6],
      [';', 6, 5], [':', 6, 6],
      [',', 7, 5], ['.', 7, 6],
    ];
    for (const [key, row, bit] of slots) {
      const k = new SamKeyboard();
      expect(k.handleKeyEvent(chr(key), true)).toBe(true);
      expect(k.readHigh(selectRow(row))).toBe(0xE0 & ~(1 << bit));
      // Unshifted: nothing else in the matrix is disturbed.
      expect(k.readLow(selectRow(0))).toBe(0x1F);
    }
  });

  it('reaches EDIT and INV, which have no printable character', () => {
    const edit = new SamKeyboard();
    edit.handleKeyEvent(ev('Home'), true);
    expect(edit.readHigh(selectRow(6))).toBe(0xE0 & ~(1 << 7));

    const inv = new SamKeyboard();
    inv.handleKeyEvent(ev('Insert'), true);
    expect(inv.readHigh(selectRow(7))).toBe(0xE0 & ~(1 << 7));
  });
});

describe('SamKeyboard F0-F9 keypad', () => {
  const down = (k: SamKeyboard, row: number, bit: number) => bit < 5
    ? (k.readLow(selectRow(row)) & (1 << bit)) === 0
    : (k.readHigh(selectRow(row)) & (1 << bit)) === 0;

  it('answers the function keys and the numeric keypad alike', () => {
    // The SAM's F0-F9 are a keypad down the left of the machine; the host's
    // function keys and its numeric keypad both reach them, whichever it has.
    for (const code of ['F9', 'Numpad9']) {
      const k = new SamKeyboard();
      expect(k.handleKeyEvent(ev(code), true)).toBe(true);
      expect(down(k, 2, 7)).toBe(true);
    }
    for (const code of ['F10', 'Numpad0']) {
      const k = new SamKeyboard();
      k.handleKeyEvent(ev(code), true);
      expect(down(k, 5, 7)).toBe(true);
    }
  });

  it('keeps Ctrl and Alt on SYMBOL, so Alt+9 is still the |-chord', () => {
    const k = new SamKeyboard();
    k.handleKeyEvent(ev('AltLeft'), true);
    k.handleKeyEvent(ev('Digit9'), true);
    expect(down(k, 7, 1)).toBe(true);      // SYMBOL
    expect(down(k, 4, 1)).toBe(true);      // 9
  });
});

describe('SamKeyboard symbol chords', () => {
  /** True when [row,bit] is currently held. */
  const down = (k: SamKeyboard, row: number, bit: number) => bit < 5
    ? (k.readLow(selectRow(row)) & (1 << bit)) === 0
    : (k.readHigh(selectRow(row)) & (1 << bit)) === 0;

  it('routes SYMBOL chords for the brackets the SAM has no keys for', () => {
    const cases: [string, number, number][] = [
      ['[', 2, 3], [']', 2, 4],       // SYMBOL + R / T
      ['{', 1, 3], ['}', 1, 4],       // SYMBOL + F / G
      ['<', 2, 0], ['>', 2, 1],       // SYMBOL + Q / W
      ['?', 0, 2],                    // SYMBOL + X
      ['^', 6, 4],                    // SYMBOL + H
      ['|', 4, 1],                    // SYMBOL + 9
    ];
    for (const [key, row, bit] of cases) {
      const k = new SamKeyboard();
      expect(k.handleKeyEvent(chr(key), true)).toBe(true);
      expect(down(k, 7, 1)).toBe(true);          // SYMBOL
      expect(down(k, row, bit)).toBe(true);
    }
  });

  it('hides the host Shift under a chord that does not want it', () => {
    // A UK layout types `"` as Shift+2. That must arrive as the bare QUOTES
    // key: leaving SHIFT down would make it `@` instead.
    const k = new SamKeyboard();
    k.handleKeyEvent(ev('ShiftLeft'), true);
    k.handleKeyEvent(chr('"', 'Digit2', true), true);
    expect(down(k, 5, 6)).toBe(true);            // QUOTES
    expect(down(k, 0, 0)).toBe(false);           // SHIFT suppressed

    // Releasing the chord while Shift is still held brings SHIFT back.
    k.handleKeyEvent(chr('"', 'Digit2', true), false);
    expect(down(k, 5, 6)).toBe(false);
    expect(down(k, 0, 0)).toBe(true);
  });

  it('keeps SHIFT for a chord that needs it', () => {
    const k = new SamKeyboard();
    k.handleKeyEvent(chr('!', 'Digit1', true), true);
    expect(down(k, 0, 0)).toBe(true);            // SHIFT
    expect(down(k, 3, 0)).toBe(true);            // 1
  });

  it('releases the chord it pressed even if the host modifiers moved on', () => {
    const k = new SamKeyboard();
    k.handleKeyEvent(chr('{', 'BracketLeft', true), true);
    expect(down(k, 7, 1)).toBe(true);
    // The host reports the release with a different character (Shift let go
    // first), but the release is keyed on the code, so the chord still lifts.
    k.handleKeyEvent(chr('[', 'BracketLeft'), false);
    expect(down(k, 7, 1)).toBe(false);
    expect(down(k, 1, 3)).toBe(false);
  });

  it('leaves letters, digits and space to their physical positions', () => {
    // A game reading the matrix wants Q where Q is, not wherever `q` prints.
    const k = new SamKeyboard();
    k.handleKeyEvent(chr('q', 'KeyQ'), true);
    expect(down(k, 2, 0)).toBe(true);
    k.handleKeyEvent(chr('7', 'Digit7'), true);
    expect(down(k, 4, 3)).toBe(true);
    k.handleKeyEvent(chr(' ', 'Space'), true);
    expect(down(k, 7, 0)).toBe(true);
  });
});
