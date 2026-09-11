/**
 * AceKeyboard — the 8×5 half-row matrix (MAME cantab/jupace.cpp).
 *
 * Rows are selected by active-low bits of the port high byte; keys are
 * active-low. Expected bit patterns are worked out from the matrix:
 *   row 0: SHIFT(0) SYM(1) Z(2) X(3) C(4)
 *   row 1: A S D F G   ·   row 3: 1 2 3 4 5   ·   row 5: P O I U Y
 */

import { describe, it, expect } from 'vitest';
import { AceKeyboard } from '@/machines/jupiter-ace/keyboard.ts';

describe('AceKeyboard — matrix readout', () => {
  it('reads 0x1F with all keys released (bits 5-7 excluded)', () => {
    const kb = new AceKeyboard();
    expect(kb.readHalfRows(0xFE)).toBe(0x1F);
    expect(kb.readHalfRows(0xFF)).toBe(0x1F); // no row selected
  });

  it('Z presses row 0 bit 2 (0x1B in the 5-bit readout)', () => {
    const kb = new AceKeyboard();
    expect(kb.handleKeyEvent('KeyZ', true)).toBe(true);
    expect(kb.readHalfRows(0xFE)).toBe(0x1B);
  });

  it('two keys on one row AND together (Z + X → 0x13)', () => {
    const kb = new AceKeyboard();
    kb.handleKeyEvent('KeyZ', true);
    kb.handleKeyEvent('KeyX', true);
    expect(kb.readHalfRows(0xFE)).toBe(0x13);
  });

  it('keys on different rows AND together when both rows are selected', () => {
    const kb = new AceKeyboard();
    kb.handleKeyEvent('KeyZ', true); // row 0, bit 2 → 0x1B
    kb.handleKeyEvent('KeyA', true); // row 1, bit 0 → 0x1E
    // 0xFC selects rows 0 and 1: 0x1B & 0x1E = 0x1A
    expect(kb.readHalfRows(0xFC)).toBe(0x1A);
  });

  it('release restores the row byte', () => {
    const kb = new AceKeyboard();
    kb.handleKeyEvent('KeyA', true);
    kb.handleKeyEvent('KeyA', false);
    expect(kb.readHalfRows(0xFD)).toBe(0x1F);
  });

  it('an unmapped key code reports false and presses nothing', () => {
    const kb = new AceKeyboard();
    expect(kb.handleKeyEvent('F9', true)).toBe(false);
    expect(kb.readHalfRows(0xFE)).toBe(0x1F);
  });
});

describe('AceKeyboard — combos', () => {
  it('ArrowLeft is SHIFT + 5, with the modifier pressed first', () => {
    const kb = new AceKeyboard();
    kb.handleKeyEvent('ArrowLeft', true);
    // The deferred key lands on processPending() (called once per frame).
    kb.processPending();
    // SHIFT: row 0 bit 0 low → 0x1E.
    expect(kb.readHalfRows(0xFE)).toBe(0x1E);
    // 5: row 3 bit 4 low → 0x0F.
    expect(kb.readHalfRows(0xF7)).toBe(0x0F);
  });

  it('releasing the combo releases both keys', () => {
    const kb = new AceKeyboard();
    kb.handleKeyEvent('ArrowLeft', true);
    kb.processPending();
    kb.handleKeyEvent('ArrowLeft', false);
    kb.processPending();
    expect(kb.readHalfRows(0xFE)).toBe(0x1F);
    expect(kb.readHalfRows(0xF7)).toBe(0x1F);
  });

  it('ShiftRight is the dedicated SYMBOL SHIFT key (row 0, bit 1)', () => {
    const kb = new AceKeyboard();
    kb.handleKeyEvent('ShiftRight', true);
    expect(kb.readHalfRows(0xFE)).toBe(0x1D);
  });
});

describe('AceKeyboard — symbol characters', () => {
  it("';' is SYMBOL SHIFT + O (rows 0 and 5, bit 1 each)", () => {
    const kb = new AceKeyboard();
    kb.handleKeyEvent('Semicolon', true, ';');
    expect(kb.readHalfRows(0xFE)).toBe(0x1D); // SYM: row 0 bit 1
    expect(kb.readHalfRows(0xDF)).toBe(0x1D); // O:  row 5 bit 1
  });

  it("'.' is SYMBOL SHIFT + M", () => {
    const kb = new AceKeyboard();
    kb.handleKeyEvent('Period', true, '.');
    expect(kb.readHalfRows(0xFE)).toBe(0x1D);
    expect(kb.readHalfRows(0x7F)).toBe(0x1D); // M: row 7 bit 1
  });

  it("Shift+digit types the Ace's shifted character (SHIFT + key, not a symbol combo)", () => {
    const kb = new AceKeyboard();
    // With Shift held, host '!' (Shift+1) must reach the Ace as CS + 1 — the
    // digit key must NOT be intercepted as a symbol combo.
    kb.handleKeyEvent('ShiftLeft', true);
    kb.handleKeyEvent('Digit1', true, '!');
    // SHIFT: row 0 bit 0 low → 0x1E; 1: row 3 bit 0 low → 0x1E.
    // (The CHAR_MAP path would have pressed SYMBOL SHIFT bit 1 instead → 0x1D.)
    expect(kb.readHalfRows(0xFE)).toBe(0x1E);
    expect(kb.readHalfRows(0xF7)).toBe(0x1E);
  });
});
