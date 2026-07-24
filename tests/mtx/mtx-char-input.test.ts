import { describe, expect, it } from 'vitest';
import { MtxKeyboard } from '@/machines/mtx/mtx-keyboard.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

function ev(key: string, code = '', shift = false): HostKeyEvent {
  return { key, code, shift, ctrl: false, alt: false };
}

/** True when matrix cell [drive,sense] reads as pressed (active low). */
function down(kb: MtxKeyboard, drive: number, sense: number): boolean {
  kb.selectDrive(0xFF & ~(1 << drive));
  const reg = sense < 8 ? kb.readSenseLow() : kb.readSenseHigh();
  const bit = sense < 8 ? sense : sense - 8;
  return (reg & (1 << bit)) === 0;
}

const SHIFT: [number, number] = [6, 0];

/**
 * Character-intent input: pressing the PC key legended with a character makes
 * the MTX produce that character, regardless of the MTX's own key positions.
 * The keyboard drives the matrix from the event's `key`, forcing the Shift cell
 * to match the ROM legend (basic.rom 0x1729/0x177A) rather than the physical
 * Shift key. This is what lets ':' (matrix cell [5,5], previously unmapped) be
 * typed, and puts '=' on Shift+Minus, etc.
 */
describe('MTX character-intent keyboard input', () => {
  it("types ':' on its own cell [5,5], unshifted (was unreachable)", () => {
    const kb = new MtxKeyboard();
    kb.handleEvent(ev(':'), true);
    expect(down(kb, 5, 5)).toBe(true);
    expect(down(kb, ...SHIFT)).toBe(false);
  });

  it("types '*' as Shift + the ':' cell [5,5]", () => {
    const kb = new MtxKeyboard();
    kb.handleEvent(ev('*'), true);
    expect(down(kb, 5, 5)).toBe(true);
    expect(down(kb, ...SHIFT)).toBe(true);
  });

  it("types '_' on cell [7,5] (was unreachable)", () => {
    const kb = new MtxKeyboard();
    kb.handleEvent(ev('_'), true);
    expect(down(kb, 7, 5)).toBe(true);
  });

  it("puts '=' on Shift + Minus [0,5], per the MTX legend", () => {
    const kb = new MtxKeyboard();
    kb.handleEvent(ev('='), true);
    expect(down(kb, 0, 5)).toBe(true);
    expect(down(kb, ...SHIFT)).toBe(true);
  });

  it("types '(' as Shift + Digit8 [1,4]", () => {
    const kb = new MtxKeyboard();
    kb.handleEvent(ev('('), true);
    expect(down(kb, 1, 4)).toBe(true);
    expect(down(kb, ...SHIFT)).toBe(true);
  });

  it('derives shift from the character, ignoring the physical Shift key', () => {
    // A PC user makes ':' by pressing Shift+; — the physical Shift must not
    // leak into the matrix and turn ':' into '*'.
    const kb = new MtxKeyboard();
    kb.handleEvent(ev('Shift', 'ShiftLeft', false), true);
    kb.handleEvent(ev(':'), true);
    expect(down(kb, 5, 5)).toBe(true);
    expect(down(kb, ...SHIFT)).toBe(false);
  });

  it('types letters on their cell without shift (uppercase via the MTX caps state)', () => {
    const kb = new MtxKeyboard();
    kb.handleEvent(ev('a'), true);
    expect(down(kb, 5, 0)).toBe(true); // KeyA
    expect(down(kb, ...SHIFT)).toBe(false);
    kb.handleEvent(ev('A'), true); // capital: still unshifted cell
    expect(down(kb, 5, 0)).toBe(true);
    expect(down(kb, ...SHIFT)).toBe(false);
  });

  it('releases the cell and shift when the character is released', () => {
    const kb = new MtxKeyboard();
    kb.handleEvent(ev('='), true);
    kb.handleEvent(ev('='), false);
    expect(down(kb, 0, 5)).toBe(false);
    expect(down(kb, ...SHIFT)).toBe(false);
  });

  it('still routes control keys (Enter) through the physical code path', () => {
    const kb = new MtxKeyboard();
    kb.handleEvent(ev('Enter', 'Enter'), true);
    expect(down(kb, 5, 6)).toBe(true); // Enter cell
  });
});
