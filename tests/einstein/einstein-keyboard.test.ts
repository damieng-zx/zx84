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

describe('Einstein character typing (the MCP `type` path)', () => {
  let kb: EinsteinKeyboard;
  beforeEach(() => { kb = new EinsteinKeyboard(); });

  /** The characters the Einstein's printed caps can produce. */
  it('presses the cap each printable character is printed on', () => {
    // Each cell is the printed legend, read off the deck (ui/keyboard/layout.ts)
    // and cross-checked against what MOS 1.2 echoes at the BASIC prompt.
    const cases: readonly [string, number, number, boolean][] = [
      // char, line, bit, needs SHIFT
      ['a', 6, 6, false], ['z', 7, 6, false],
      ['A', 6, 6, true], ['Z', 7, 6, true],
      ['1', 4, 6, false], ['!', 4, 6, true],
      ['0', 1, 7, false], ['@', 1, 7, true],
      ['"', 4, 5, true], ['(', 3, 3, true], [')', 2, 6, true],
      [';', 2, 2, false], ['+', 2, 2, true],
      [':', 2, 3, false], ['*', 2, 3, true],
      ['=', 3, 5, false], ['-', 3, 5, true],
      [',', 3, 0, false], ['<', 3, 0, true],
      ['.', 3, 1, false], ['>', 3, 1, true],
      ['/', 3, 2, false], ['?', 3, 2, true],
      ['_', 1, 4, false], [' ', 0, 6, false],
    ];
    for (const [ch, line, bit, shift] of cases) {
      const before = kb.statusByte();
      expect(kb.pressChar(ch, true), ch).toBe(true);
      expect(scan(kb, line), `${ch} should pull bit ${bit} of line ${line} low`).toBe(0xFF & ~(1 << bit));
      // Only the shifted caps may move SHIFT.
      expect((kb.statusByte() & 0x80) === 0, `${ch} SHIFT`).toBe(shift);
      kb.pressChar(ch, false);
      expect(scan(kb, line), `${ch} released`).toBe(0xFF);
      expect(kb.statusByte(), `${ch} leaves no modifier stuck`).toBe(before);
    }
  });

  it('reports false for characters no cap prints, leaving the keyboard alone', () => {
    const before = kb.statusByte();
    for (const ch of ['~', '[', ']', '{', '}', '\\', '|', '\n', '\t']) {
      expect(kb.pressChar(ch, true), ch).toBe(false);
    }
    expect(kb.statusByte()).toBe(before);
    for (let line = 0; line < 8; line++) expect(scan(kb, line)).toBe(0xFF);
  });

  it('does not put `"` behind an SYM chord — the Spectrum path that typed a control code', () => {
    // The bug this pins: with no charDown, the MCP `type` tool resolved symbols
    // through the Spectrum's CHAR_KEYS, where `"` is SYM+P and `:` is SYM+Z. On
    // an Einstein those chords are the PSG's I/O ports, so a listing came out
    // as control codes (`^P^P^Z`) instead of `"A":`.
    expect(kb.pressChar('"', true)).toBe(true);
    expect(scan(kb, 4)).toBe(0xFF & ~0x20);       // the `2` cap
    expect(kb.statusByte() & 0x80).toBe(0);       // SHIFT held with it
    kb.pressChar('"', false);
    expect(scan(kb, 4)).toBe(0xFF);
    expect(scan(kb, 7)).toBe(0xFF);               // no SYM cell was touched
  });
});

describe('Einstein 256 host key mapping', () => {
  let kb: EinsteinKeyboard;
  beforeEach(() => { kb = new EinsteinKeyboard('einstein-256'); });

  it('routes the four-wedge pad the way MOS 2.1 decodes it', () => {
    // Down and right are the TC-01's own cursor cells, unshifted.
    kb.handleKeyEvent('ArrowDown', true);
    expect(scan(kb, 1)).toBe(0xFF & ~0x20);
    kb.handleKeyEvent('ArrowDown', false);
    kb.handleKeyEvent('ArrowRight', true);
    expect(scan(kb, 2)).toBe(0xFF & ~0x20);
    kb.handleKeyEvent('ArrowRight', false);

    // Left has a cell of its own that the TC-01 never used.
    kb.handleKeyEvent('ArrowLeft', true);
    expect(scan(kb, 0)).toBe(0xFF & ~0x02);
    expect(kb.statusByte() & 0xC0).toBe(0xC0);
    kb.handleKeyEvent('ArrowLeft', false);

    // Up has none, so it goes through CONTROL+K.
    kb.handleKeyEvent('ArrowUp', true);
    expect(scan(kb, 2)).toBe(0xFF & ~0x01);
    expect(kb.statusByte() & 0x40).toBe(0);
    kb.handleKeyEvent('ArrowUp', false);
    expect(scan(kb, 2)).toBe(0xFF);
    expect(kb.statusByte() & 0x40).toBe(0x40);
  });

  it('does not reach for SHIFT, which MOS 2.1 ignores on the cursor cells', () => {
    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      kb.handleKeyEvent(code, true);
      expect(kb.statusByte() & 0x80, code).toBe(0x80);
      kb.handleKeyEvent(code, false);
    }
  });
});
