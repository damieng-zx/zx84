import { describe, it, expect, beforeEach } from 'vitest';
import { EinsteinKeyboard, STATUS_LINE } from '@/machines/einstein/einstein-keyboard.ts';

/** Select one row (active-low) and read back its columns. */
function scan(kb: EinsteinKeyboard, line: number): number {
  kb.selectRows(~(1 << line) & 0xFF);
  return kb.readColumns();
}

describe('Einstein keyboard matrix', () => {
  let kb: EinsteinKeyboard;
  beforeEach(() => { kb = new EinsteinKeyboard(); });

  it('scans only the selected rows, ANDing several together', () => {
    kb.setKey(6, 6, true);           // A
    kb.setKey(5, 6, true);           // Q
    expect(scan(kb, 6)).toBe(0xFF & ~0x40);
    expect(scan(kb, 5)).toBe(0xFF & ~0x40);
    expect(scan(kb, 4)).toBe(0xFF);
    kb.selectRows(~((1 << 6) | (1 << 4)) & 0xFF);
    expect(kb.readColumns()).toBe(0xFF & ~0x40);
  });

  it('drives SHIFT / CONTROL / GRAPH through the synthetic status line', () => {
    kb.setKey(STATUS_LINE, 7, true);
    expect(kb.statusByte() & 0x80).toBe(0);
    kb.setKey(STATUS_LINE, 6, true);
    kb.setKey(STATUS_LINE, 5, true);
    expect(kb.statusByte() & 0xE0).toBe(0);
    // The status line is not a scanned row — no matrix bit moved.
    expect(scan(kb, 7)).toBe(0xFF);
    kb.setKey(STATUS_LINE, 7, false);
    expect(kb.statusByte() & 0x80).toBe(0x80);
  });

  it('exposes nine rows, the last mirroring the status modifiers', () => {
    kb.setKey(7, 0, true);           // M
    kb.setKey(STATUS_LINE, 7, true); // SHIFT
    const rows = kb.rows;
    expect(rows.length).toBe(9);
    expect(rows[7]).toBe(0xFF & ~0x01);
    expect(rows[STATUS_LINE] & 0x80).toBe(0);
    // Joystick / printer bits never read as pressed keys.
    expect(rows[STATUS_LINE] & 0x1F).toBe(0x1F);
  });
});

describe('Einstein host key mapping', () => {
  let kb: EinsteinKeyboard;
  beforeEach(() => { kb = new EinsteinKeyboard(); });

  it('puts both cursor directions on one cap, SHIFT picking the upper legend', () => {
    // ⇨ and ⇩ are the unshifted halves of their caps.
    kb.handleKeyEvent('ArrowRight', true);
    expect(scan(kb, 2)).toBe(0xFF & ~0x20);
    expect(kb.statusByte() & 0x80).toBe(0x80);
    kb.handleKeyEvent('ArrowRight', false);

    // ⇦ is the same cell with SHIFT asserted for as long as it is held.
    kb.handleKeyEvent('ArrowLeft', true);
    expect(scan(kb, 2)).toBe(0xFF & ~0x20);
    expect(kb.statusByte() & 0x80).toBe(0);
    kb.handleKeyEvent('ArrowLeft', false);
    expect(scan(kb, 2)).toBe(0xFF);
    expect(kb.statusByte() & 0x80).toBe(0x80);

    kb.handleKeyEvent('ArrowUp', true);
    expect(scan(kb, 1)).toBe(0xFF & ~0x20);
    expect(kb.statusByte() & 0x80).toBe(0);
    kb.handleKeyEvent('ArrowUp', false);
    kb.handleKeyEvent('ArrowDown', true);
    expect(scan(kb, 1)).toBe(0xFF & ~0x20);
    expect(kb.statusByte() & 0x80).toBe(0x80);
  });

  it('survives auto-repeat on a shift-forcing key', () => {
    kb.handleKeyEvent('ArrowUp', true);
    kb.handleKeyEvent('ArrowUp', true);
    kb.handleKeyEvent('ArrowUp', false);
    expect(kb.statusByte() & 0x80).toBe(0x80);
  });

  it('keeps a held SHIFT asserted after a forced-shift key is released', () => {
    kb.handleKeyEvent('ShiftLeft', true);
    kb.handleKeyEvent('ArrowLeft', true);
    kb.handleKeyEvent('ArrowLeft', false);
    expect(kb.statusByte() & 0x80).toBe(0);
  });

  it('leaves Tab alone — the Einstein deck has no TAB key', () => {
    expect(kb.handleKeyEvent('Tab', true)).toBe(false);
    expect(scan(kb, 2)).toBe(0xFF);
  });
});
