/**
 * The Ace keyboard matrix, proved against the real ROM rather than any other
 * emulator. The ROM's scan routine (0x0336) reads the eight half-rows and turns
 * the one pressed key into an index into a 40-entry table; which table depends
 * on the two modifiers in row 0:
 *
 *   0x0376  plain          SHIFT = row 0 bit 0 selects 0x039E
 *   0x039E  SHIFT          SYMBOL SHIFT = row 0 bit 1 selects 0x03C6
 *   0x03C6  SYMBOL SHIFT
 *
 * The index counts down the rows within each column: entry = (4 - bit) * 8 +
 * (7 - row). Row 0's modifier cells (bits 0 and 1) hold 0 in every table.
 *
 * Needs the 8K Ace ROM: place it at mcp/.cache/ace.rom (the MCP server fetches
 * it there) or point ACE_ROM at it. Skipped without it.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AceKeyboard } from '@/machines/jupiter-ace/keyboard.ts';

const ROM_PATH = process.env.ACE_ROM ?? join(import.meta.dirname, '../../mcp/.cache/ace.rom');

const PLAIN = 0x0376;
const SHIFT = 0x039e;
const SYMBOL = 0x03c6;

type Cell = readonly [row: number, bit: number];

const tableIndex = ([row, bit]: Cell): number => (4 - bit) * 8 + (7 - row);

/** Every cell that is neither modifier. */
const KEY_CELLS: Cell[] = [];
for (let row = 0; row < 8; row++) {
  for (let bit = 0; bit < 5; bit++) {
    if (row === 0 && bit < 2) continue;
    KEY_CELLS.push([row, bit]);
  }
}

/** The cells currently held down on a keyboard. */
function pressed(kb: AceKeyboard): Cell[] {
  const out: Cell[] = [];
  for (let row = 0; row < 8; row++) {
    for (let bit = 0; bit < 5; bit++) {
      if ((kb.rows[row] & (1 << bit)) === 0) out.push([row, bit]);
    }
  }
  return out;
}

describe.skipIf(!existsSync(ROM_PATH))('Ace keyboard matrix against the ROM key tables', () => {
  const rom = existsSync(ROM_PATH) ? new Uint8Array(readFileSync(ROM_PATH)) : new Uint8Array(0);

  it('has the 8K ROM', () => {
    expect(rom.length).toBe(0x2000);
  });

  it('puts both modifiers on row 0, SHIFT on bit 0 and SYMBOL SHIFT on bit 1', () => {
    for (const base of [PLAIN, SHIFT, SYMBOL]) {
      expect(rom[base + tableIndex([0, 0])]).toBe(0);
      expect(rom[base + tableIndex([0, 1])]).toBe(0);
    }
    const kb = new AceKeyboard();
    kb.handleKeyEvent('ShiftLeft', true);
    expect(pressed(kb)).toEqual([[0, 0]]);
    kb.reset();
    kb.handleKeyEvent('ShiftRight', true);
    expect(pressed(kb)).toEqual([[0, 1]]);
  });

  it('maps every letter, digit, space and enter to the cell the ROM decodes as that character', () => {
    const hostKeys: [string, number][] = [
      ...'abcdefghijklmnopqrstuvwxyz'.split('').map(c => [`Key${c.toUpperCase()}`, c.charCodeAt(0)] as [string, number]),
      ...'0123456789'.split('').map(c => [`Digit${c}`, c.charCodeAt(0)] as [string, number]),
      ['Space', 0x20],
      ['Enter', 0x0d],
    ];
    for (const [code, ch] of hostKeys) {
      const kb = new AceKeyboard();
      expect(kb.handleKeyEvent(code, true), code).toBe(true);
      const cells = pressed(kb);
      expect(cells, code).toHaveLength(1);
      expect(rom[PLAIN + tableIndex(cells[0])], code).toBe(ch);
    }
  });

  it('covers every key position the ROM defines', () => {
    const reachable = new Set<number>();
    const codes = [
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => `Key${c}`),
      ...'0123456789'.split('').map(c => `Digit${c}`), 'Space', 'Enter',
    ];
    for (const code of codes) {
      const kb = new AceKeyboard();
      kb.handleKeyEvent(code, true);
      reachable.add(tableIndex(pressed(kb)[0]));
    }
    for (const cell of KEY_CELLS) {
      expect(reachable.has(tableIndex(cell)), `row ${cell[0]} bit ${cell[1]}`).toBe(true);
    }
  });

  it('sends the editing keys as SHIFT plus the key the ROM turns into that control code', () => {
    const expected: [string, number][] = [
      ['Backspace', 0x05], ['Delete', 0x05],
      ['ArrowLeft', 0x01], ['ArrowUp', 0x07], ['ArrowDown', 0x09], ['ArrowRight', 0x03],
      ['CapsLock', 0x02],
    ];
    for (const [code, control] of expected) {
      const kb = new AceKeyboard();
      expect(kb.handleKeyEvent(code, true), code).toBe(true);
      kb.processPending();
      const cells = pressed(kb);
      const shift = cells.find(([row, bit]) => row === 0 && bit === 0);
      const key = cells.find(([row, bit]) => !(row === 0 && bit === 0));
      expect(shift, code).toBeDefined();
      expect(key, code).toBeDefined();
      expect(rom[SHIFT + tableIndex(key!)], code).toBe(control);
    }
  });

  it('types every symbol it knows as SYMBOL SHIFT plus the key the ROM decodes as that character', () => {
    let typed = 0;
    for (let ch = 0x21; ch <= 0x7e; ch++) {
      const kb = new AceKeyboard();
      // A code with no mapping of its own, so only the character table can answer.
      if (!kb.handleKeyEvent('Backquote', true, String.fromCharCode(ch))) continue;
      typed++;
      const cells = pressed(kb);
      const symbol = cells.find(([row, bit]) => row === 0 && bit === 1);
      const key = cells.find(([row, bit]) => !(row === 0 && bit === 1));
      expect(symbol, String.fromCharCode(ch)).toBeDefined();
      expect(cells, String.fromCharCode(ch)).toHaveLength(2);
      expect(rom[SYMBOL + tableIndex(key!)], String.fromCharCode(ch)).toBe(ch);
    }
    expect(typed).toBeGreaterThan(25);
  });
});
