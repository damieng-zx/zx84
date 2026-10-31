import { describe, it, expect } from 'vitest';
import { NewBrainKeyboard, MODIFIER_LEAD, MIN_HOLD } from '@/machines/newbrain/keyboard.ts';
import { K3, K7, K8, K9 } from '@/machines/newbrain/cop-board.ts';

function setup() {
  const keys = new Uint8Array(16);
  const kb = new NewBrainKeyboard(() => keys);
  const tick = (n: number) => { for (let i = 0; i < n; i++) kb.tick(); };
  return { keys, kb, tick };
}

describe('NewBrain keyboard', () => {
  it('presses an unshifted character at once, in the position the ROM decodes it from', () => {
    const { keys, kb } = setup();
    kb.handleKeyEvent('KeyA', true, 'a');
    expect(keys[13]).toBe(K7);               // Y13 K7 is "a"
    expect(keys[15]).toBe(0);
  });

  it('puts SHIFT down first and the key MODIFIER_LEAD frames later for a capital', () => {
    const { keys, kb, tick } = setup();
    kb.handleKeyEvent('KeyA', true, 'A');
    expect(keys[15]).toBe(K7);               // SHIFT is Y15 K7
    expect(keys[13]).toBe(0);                // the key waits: the COP scans Y15 last
    tick(MODIFIER_LEAD - 1);
    expect(keys[13]).toBe(0);
    tick(1);
    expect(keys[13]).toBe(K7);
  });

  it('holds a tapped key for at least MIN_HOLD frames, then lets go of it and its SHIFT together', () => {
    const { keys, kb, tick } = setup();
    kb.handleKeyEvent('Digit2', true, '"');  // shift-2
    tick(MODIFIER_LEAD);
    kb.handleKeyEvent('Digit2', false, '"'); // released on the very frame it went down
    tick(MIN_HOLD - 1);
    expect(keys[7]).toBe(K8);                // still down: Y7 K8 is "2"
    expect(keys[15]).toBe(K7);
    tick(1);
    expect(keys[7]).toBe(0);
    expect(keys[15]).toBe(0);
  });

  it('keeps a shared SHIFT down until the last shifted key is released', () => {
    const { keys, kb, tick } = setup();
    kb.handleKeyEvent('KeyA', true, 'A');
    kb.handleKeyEvent('KeyB', true, 'B');
    tick(MODIFIER_LEAD + MIN_HOLD);
    kb.handleKeyEvent('KeyA', false, 'A');
    tick(1);
    expect(keys[13]).toBe(0);
    expect(keys[15]).toBe(K7);               // B still needs it
    kb.handleKeyEvent('KeyB', false, 'B');
    tick(1);
    expect(keys[15]).toBe(0);
  });

  it('swallows the host SHIFT key rather than forwarding it, and ignores auto-repeat', () => {
    const { keys, kb } = setup();
    expect(kb.handleKeyEvent('ShiftLeft', true, 'Shift')).toBe(true);
    expect(keys.every(k => k === 0)).toBe(true);
    kb.handleKeyEvent('KeyA', true, 'a');
    kb.handleKeyEvent('KeyA', true, 'a');
    kb.handleKeyEvent('KeyA', false, 'a');
    expect(keys[13]).toBe(K7);               // still held for MIN_HOLD
  });

  it('maps the cursor keys, NEW LINE, SPACE and the modifiers', () => {
    const { keys, kb } = setup();
    for (const [code, y, k] of [
      ['ArrowUp', 1, K3], ['ArrowDown', 1, K7], ['ArrowLeft', 1, K8], ['ArrowRight', 1, K9],
      ['Enter', 13, K9], ['Space', 14, K8], ['ControlLeft', 15, K3], ['AltLeft', 15, K9],
    ] as [string, number, number][]) {
      keys.fill(0);
      kb.reset();
      expect(kb.handleKeyEvent(code, true, ''), code).toBe(true);
      expect(keys[y] & k, code).toBe(k);
    }
  });

  it('types BACKSPACE as CONTROL with the left cursor key', () => {
    const { keys, kb, tick } = setup();
    kb.handleKeyEvent('Backspace', true, 'Backspace');
    expect(keys[15]).toBe(K3);               // CONTROL first
    tick(MODIFIER_LEAD);
    expect(keys[1]).toBe(K8);
  });

  it('does not claim keys it has no use for', () => {
    const { kb } = setup();
    expect(kb.handleKeyEvent('F5', true, 'F5')).toBe(false);
    expect(kb.handleKeyEvent('F5', false, 'F5')).toBe(false);
  });

  it('releases everything on reset', () => {
    const { keys, kb } = setup();
    kb.handleKeyEvent('KeyA', true, 'A');
    kb.reset();
    expect(keys.every(k => k === 0)).toBe(true);
  });
});
