/**
 * SpectrumKeyboard — 8 half-rows × 5 bits, active-low.
 *
 * Reference: ZX Spectrum manual Chapter 23, "The Keyboard".
 *   Row 0 (port 0xFEFE): SHIFT Z X C V
 *   Row 1 (port 0xFDFE): A S D F G
 *   Row 2 (port 0xFBFE): Q W E R T
 *   Row 3 (port 0xF7FE): 1 2 3 4 5
 *   Row 4 (port 0xEFFE): 0 9 8 7 6
 *   Row 5 (port 0xDFFE): P O I U Y
 *   Row 6 (port 0xBFFE): ENTER L K J H
 *   Row 7 (port 0x7FFE): SPACE SYM-SHIFT M N B
 *
 * The high byte of the ULA port doubles as a row selector (active-low),
 * so multiple rows can be merged by zeroing several high-byte bits at once.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SpectrumKeyboard } from '@/keyboard.ts';

function pressed(k: SpectrumKeyboard, row: number, bit: number): boolean {
  return (k.rows[row] & (1 << bit)) === 0;
}

describe('SpectrumKeyboard — initial state', () => {
  it('all rows idle = 0xFF (no keys pressed, active-low)', () => {
    const k = new SpectrumKeyboard();
    expect(k.rows.length).toBe(8);
    expect(Array.from(k.rows)).toEqual([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  });
});

describe('SpectrumKeyboard — setKey reference counting', () => {
  let k: SpectrumKeyboard;
  beforeEach(() => { k = new SpectrumKeyboard(); });

  it('single press/release toggles the bit active-low', () => {
    k.setKey(0, 0, true);
    expect(k.rows[0]).toBe(0xFE);
    k.setKey(0, 0, false);
    expect(k.rows[0]).toBe(0xFF);
  });

  it('multiple sources pressing the same bit only release when count hits zero', () => {
    k.setKey(0, 0, true);
    k.setKey(0, 0, true);
    expect(pressed(k, 0, 0)).toBe(true);
    k.setKey(0, 0, false); // first release — still held by source #2
    expect(pressed(k, 0, 0)).toBe(true);
    k.setKey(0, 0, false);
    expect(pressed(k, 0, 0)).toBe(false);
  });

  it('excess releases clamp at zero (no underflow)', () => {
    k.setKey(0, 0, false);
    k.setKey(0, 0, false);
    k.setKey(0, 0, true);
    k.setKey(0, 0, false);
    expect(pressed(k, 0, 0)).toBe(false);
  });
});

describe('SpectrumKeyboard — readHalfRows merges active-low row selects', () => {
  let k: SpectrumKeyboard;
  beforeEach(() => { k = new SpectrumKeyboard(); });

  it('no rows selected (high byte 0xFF) returns 0x1F', () => {
    k.setKey(0, 0, true);
    expect(k.readHalfRows(0xFF)).toBe(0x1F);
  });

  it('selecting row 0 (port 0xFEFE → high byte 0xFE) returns that row', () => {
    k.setKey(0, 0, true); // Caps Shift
    expect(k.readHalfRows(0xFE)).toBe(0x1E);
  });

  it('selecting all 8 rows simultaneously ANDs every row together', () => {
    k.setKey(0, 0, true);  // bit 0 in row 0
    k.setKey(7, 0, true);  // bit 0 in row 7 (SPACE)
    expect(k.readHalfRows(0x00)).toBe(0x1F & ~0x01);
  });

  it('result is masked to bits 0-4 (top 3 bits are not from the keyboard)', () => {
    expect(k.readHalfRows(0x00) & 0xE0).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// handleKeyEvent — physical PC keys
// ─────────────────────────────────────────────────────────────────────────

describe('handleKeyEvent — single keys', () => {
  let k: SpectrumKeyboard;
  beforeEach(() => { k = new SpectrumKeyboard(); });

  it('Enter → row 6 bit 0', () => {
    k.handleKeyEvent('Enter', true);
    expect(pressed(k, 6, 0)).toBe(true);
  });

  it('Space → row 7 bit 0', () => {
    k.handleKeyEvent('Space', true);
    expect(pressed(k, 7, 0)).toBe(true);
  });

  it('Digit1 → row 3 bit 0', () => {
    k.handleKeyEvent('Digit1', true);
    expect(pressed(k, 3, 0)).toBe(true);
  });

  it('ShiftLeft = Caps Shift (row 0 bit 0); ShiftRight = Sym Shift (row 7 bit 1)', () => {
    k.handleKeyEvent('ShiftLeft', true);
    k.handleKeyEvent('ShiftRight', true);
    expect(pressed(k, 0, 0)).toBe(true);
    expect(pressed(k, 7, 1)).toBe(true);
  });

  it('unknown PC key returns false and changes nothing', () => {
    const r = k.handleKeyEvent('F13', true);
    expect(r).toBe(false);
    expect(Array.from(k.rows)).toEqual([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  });
});

describe('handleKeyEvent — combo keys (modifier first, rest deferred one frame)', () => {
  let k: SpectrumKeyboard;
  beforeEach(() => { k = new SpectrumKeyboard(); });

  it('Backspace = Caps Shift + 0; CS lands immediately, 0 deferred', () => {
    k.handleKeyEvent('Backspace', true);
    expect(pressed(k, 0, 0)).toBe(true);  // CS
    expect(pressed(k, 4, 0)).toBe(false); // 0 not yet visible

    k.processPending();
    expect(pressed(k, 4, 0)).toBe(true);  // 0 now visible

    // Release: both come down together.
    k.handleKeyEvent('Backspace', false);
    expect(pressed(k, 0, 0)).toBe(false);
    expect(pressed(k, 4, 0)).toBe(false);
  });

  it('ArrowLeft = CS + 5 (row 3 bit 4)', () => {
    k.handleKeyEvent('ArrowLeft', true);
    k.processPending();
    expect(pressed(k, 0, 0)).toBe(true);
    expect(pressed(k, 3, 4)).toBe(true);
  });

  it('processPending clears the queue (called twice has no effect)', () => {
    k.handleKeyEvent('Backspace', true);
    k.processPending();
    // Manually release the deferred key, then processPending — must not re-press.
    k.setKey(4, 0, false);
    k.processPending();
    expect(pressed(k, 4, 0)).toBe(false);
  });
});

describe('handleKeyEvent — symbol characters (CHAR_MAP)', () => {
  let k: SpectrumKeyboard;
  beforeEach(() => { k = new SpectrumKeyboard(); });

  it('";" presses SYM SHIFT + O', () => {
    k.handleKeyEvent('Semicolon', true, ';');
    expect(pressed(k, 7, 1)).toBe(true); // Sym Shift
    expect(pressed(k, 5, 1)).toBe(true); // O
  });

  it('"," presses SYM SHIFT + N', () => {
    k.handleKeyEvent('Comma', true, ',');
    expect(pressed(k, 7, 1)).toBe(true);
    expect(pressed(k, 7, 3)).toBe(true);
  });

  it('release uses the combo stored at press time, even if Shift state changes', () => {
    k.handleKeyEvent('Semicolon', true, ';');
    // Even if upstream sends a release with no key string, we must release
    // the stored combo correctly.
    k.handleKeyEvent('Semicolon', false);
    expect(pressed(k, 7, 1)).toBe(false);
    expect(pressed(k, 5, 1)).toBe(false);
  });

  it('digit keys with shifted symbols (e.g. "!") fall through to KEY_MAP so EDIT etc. work', () => {
    // "!" arrives as code=Digit1, key="!" — CHAR_MAP is skipped for Digit*,
    // so the digit key is pressed directly, leaving the user's Shift to mean
    // CAPS SHIFT (which produces EDIT/CAPS LOCK/etc. on the Spectrum).
    k.handleKeyEvent('Digit1', true, '!');
    expect(pressed(k, 3, 0)).toBe(true);    // 1 pressed
    expect(pressed(k, 7, 1)).toBe(false);   // Sym Shift NOT pressed
  });

  it('";" while Caps Shift is physically held suppresses CS to avoid extended mode', () => {
    k.handleKeyEvent('ShiftLeft', true);
    expect(pressed(k, 0, 0)).toBe(true);
    k.handleKeyEvent('Semicolon', true, ';');
    expect(pressed(k, 0, 0)).toBe(false);   // CS suppressed
    expect(pressed(k, 7, 1)).toBe(true);    // SS asserted
    expect(pressed(k, 5, 1)).toBe(true);    // O

    // Release the symbol first — physical Shift still held → CS restored.
    k.handleKeyEvent('Semicolon', false, ';');
    expect(pressed(k, 0, 0)).toBe(true);

    k.handleKeyEvent('ShiftLeft', false);
    expect(pressed(k, 0, 0)).toBe(false);
  });

  it('if physical Shift is released before the symbol key, CS is NOT restored on release', () => {
    k.handleKeyEvent('ShiftLeft', true);
    k.handleKeyEvent('Semicolon', true, ';');
    k.handleKeyEvent('ShiftLeft', false);        // physical Shift goes up first
    expect(pressed(k, 0, 0)).toBe(false);
    k.handleKeyEvent('Semicolon', false, ';');   // releasing must not re-press CS
    expect(pressed(k, 0, 0)).toBe(false);
  });
});

describe('reset', () => {
  it('clears all rows, press counts, combos, and pending keys', () => {
    const k = new SpectrumKeyboard();
    k.handleKeyEvent('ShiftLeft', true);
    k.handleKeyEvent('Semicolon', true, ';');
    k.handleKeyEvent('Backspace', true);
    k.reset();
    expect(Array.from(k.rows)).toEqual([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    k.processPending(); // pending queue must be empty
    expect(Array.from(k.rows)).toEqual([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  });
});
