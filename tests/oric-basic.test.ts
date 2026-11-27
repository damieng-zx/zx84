/**
 * Oric BASIC listing and variables.
 *
 * The token table is read from the ROM, so the first test pins its alignment
 * against three codes the published table gives (POKE $B9, PRINT $BA, FOR $8D)
 * rather than against whatever this implementation happens to produce. The rest
 * type a program into the real ROM and read it back, which is the only way to be
 * sure the record format is the hardware's.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OricMachine } from '@/machines/oric/oric-machine.ts';
import {
  parseOricBasic, parseOricBasicVariables, readOricTokenTable,
} from '@/basic/oric-basic-parser.ts';

const CACHE = join(process.cwd(), 'mcp', '.cache');
const ATMOS_ROM = 'oric-basic11b.rom';
const hasRom = (name: string): boolean => existsSync(join(CACHE, name));
const rom = (name: string): Uint8Array => new Uint8Array(readFileSync(join(CACHE, name)));

/** Boot the Atmos and run it long enough for BASIC's prompt. */
function boot(): OricMachine {
  const m = new OricMachine('atmos', null);
  m.loadROM(rom(ATMOS_ROM));
  m.reset();
  for (let i = 0; i < 200; i++) m.tick();
  return m;
}

/**
 * Type `text` at the keyboard and let it be read in.
 *
 * The feeder hands the ROM one key every few fields, so the time a line takes
 * depends on the machine's own scan cadence rather than on a fixed count. Waiting
 * for the queue to drain (and then a little longer, for the ROM to act on it) is
 * deterministic under load; a hard-coded frame count is not.
 */
function type(m: OricMachine, text: string): void {
  m.typeText(text);
  for (let i = 0; i < 20_000 && m.pasteRemaining > 0; i++) m.tick();
  // The ROM still has to echo the line and run the statement.
  for (let i = 0; i < 200; i++) m.tick();
}

describe.runIf(hasRom(ATMOS_ROM))('oric token table', () => {
  it('aligns with the published codes for POKE, PRINT and FOR', () => {
    const table = readOricTokenTable(rom(ATMOS_ROM));
    // Three independent anchors from the Oric reference's token table. If the
    // table were read from the wrong offset, or the code base were not $80,
    // these would all be adjacent to their real words but not equal to them.
    expect(table.words[0xB9]).toBe('POKE');
    expect(table.words[0xBA]).toBe('PRINT');
    expect(table.words[0x8D]).toBe('FOR');
    // And the operator half, which shares the same table.
    expect(table.words[0xD4]).toBe('=');
    expect(table.words[0xC3]).toBe('TO');
    expect(table.words[0x80]).toBe('END');
  });
});

describe.runIf(hasRom(ATMOS_ROM))('oric BASIC listing', () => {
  it('reads back a typed program, tokens and all', () => {
    const m = boot();
    try {
      type(m, '10 REM HELLO\n20 FOR I=1 TO 3\n30 PRINT "X";I\n40 NEXT I\n');
      const listing = m.services.inspect?.basicListing?.() ?? [];
      expect(listing.map(l => l.lineNumber)).toEqual([10, 20, 30, 40]);
      expect(listing[0].text).toBe('REM HELLO');
      // The operators, TO and the tokens all have to decode for this to read
      // back as source rather than as punctuation soup.
      expect(listing[1].text).toBe('FOR I= 1 TO 3');
      expect(listing[2].text).toBe('PRINT "X";I');
      expect(listing[3].text).toBe('NEXT I');
    } finally {
      m.destroy();
    }
  });

  it('takes a REM comment literally to the end of the line', () => {
    const m = boot();
    try {
      type(m, '10 REM PRINT FOR TO END\n');
      const listing = m.services.inspect?.basicListing?.() ?? [];
      expect(listing).toHaveLength(1);
      // The words after REM must not be detokenised: they are comment text.
      expect(listing[0].text).toBe('REM PRINT FOR TO END');
    } finally {
      m.destroy();
    }
  });

  it('reports no program before anything is typed', () => {
    const m = boot();
    try {
      // A fresh machine has the one-record terminator and nothing else. An
      // empty list is what makes the pane show "(no BASIC program)".
      expect(m.services.inspect?.basicListing?.()).toEqual([]);
    } finally {
      m.destroy();
    }
  });

  it('tracks the end of the program in the $9C pointer', () => {
    const m = boot();
    try {
      const before = m.memory.ram[0x9C] | (m.memory.ram[0x9D] << 8);
      type(m, '10 PRINT "A"\n');
      const after = m.memory.ram[0x9C] | (m.memory.ram[0x9D] << 8);
      // BASIC moves $9C past the program it has stored.
      expect(after).toBeGreaterThan(before);
    } finally {
      m.destroy();
    }
  });

  it('describes where the program, variables and arrays live', () => {
    const m = boot();
    try {
      type(m, '10 PRINT "A"\n');
      const rows = parseOricBasicVariables(m.memory.ram);
      const by = Object.fromEntries(rows.map(r => [r.name, r.value]));
      // The text starts at $0501 and the program ends where the variables
      // begin; both come from BASIC's own pointers.
      expect(by.PROGRAM).toBe('$501');
      expect(by.VARIABLES).toMatch(/^\$5/);
      expect(rows.every(r => typeof r.value === 'string')).toBe(true);
    } finally {
      m.destroy();
    }
  });
});

describe('oric BASIC parser without a ROM', () => {
  it('reports nothing for an empty address space', () => {
    // A machine that has never run BASIC leaves the pointers null; the parser
    // must not invent a program out of zeros.
    const ram = new Uint8Array(0x10000);
    const table = readOricTokenTable(new Uint8Array(0x4000));
    expect(parseOricBasic(ram, table)).toEqual([]);
    expect(parseOricBasicVariables(ram)).toEqual([]);
  });
});
