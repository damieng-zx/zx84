/**
 * The Hardware-pane fit, verified against the real firmware headlessly.
 *
 * Needs the Amstrad ROMs cached in mcp/.cache (not redistributable); skipped
 * without them. Expectations come from the documented behaviour:
 *   - Links LK1–LK3 name the distributor in the sign-on banner, and LK4 = 0
 *     (60 Hz) makes the firmware program a 262-line frame (CPCWiki "8255",
 *     "LK-selectable Brand Names"; the 60 Hz CRTC set is R4 = 31, R5 = 6).
 *   - A Dk'tronics-style 256K expansion banks 64K blocks through the RAM
 *     command (OUT &7F00, %11bbbccc): BASIC can POKE a block and PEEK it back
 *     while the base RAM at the same address keeps its own byte.
 *   - The DDI-1 gives a 464 AMSDOS in ROM 7 and drive A:, so |DIR lists a
 *     disk (CPC 464 DDI-1 manual) and SAVE writes to it.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { CPC_DEFAULT_OPTIONS, type CpcOptions } from '@/machines/cpc/options.ts';
import { createBlankDisk, DISK_FORMATS } from '@/media/floppy/dsk.ts';

const CACHE = resolve(__dirname, '../../mcp/.cache');
const has = (...names: string[]): boolean => names.every(n => existsSync(resolve(CACHE, n)));
const rom = (n: string): Uint8Array => new Uint8Array(readFileSync(resolve(CACHE, n)));

/** Keys per character, by physical position on the CPC keyboard (shifted
 *  digits give the symbols above them). */
function keysFor(ch: string): string[] {
  if (/[a-z]/i.test(ch)) return ['Key' + ch.toUpperCase()];
  if (/[0-9]/.test(ch)) return ['Digit' + ch];
  switch (ch) {
    case ' ': return ['Space'];
    case '\n': return ['Enter'];
    case '"': return ['ShiftLeft', 'Digit2'];
    case '(': return ['ShiftLeft', 'Digit8'];
    case ')': return ['ShiftLeft', 'Digit9'];
    case ',': return ['Comma'];
    case ':': return ['Quote'];
    case '|': return ['ShiftLeft', 'IntlBackslash'];
    default: throw new Error(`no key for ${ch}`);
  }
}

function type(m: CpcMachine, s: string): void {
  for (const ch of s) {
    const codes = keysFor(ch);
    for (const c of codes) m.keyboard.handleKeyEvent(c, true);
    for (let f = 0; f < 3; f++) m.tick();
    for (const c of codes) m.keyboard.handleKeyEvent(c, false);
    for (let f = 0; f < 3; f++) m.tick();
  }
}

function boot(model: 'cpc464' | 'cpc6128', over: Partial<CpcOptions>, frames = 150): CpcMachine {
  const m = new CpcMachine(model, null);
  m.fit({ ...CPC_DEFAULT_OPTIONS, ...over });
  if (model === 'cpc6128') m.memory.loadRoms(rom('os6128.rom'), rom('basic1-1.rom'), rom('amsdos.rom'));
  else m.memory.loadRoms(rom('os464.rom'), rom('basic1-0.rom'));
  m.reset();
  // The DDI-1's AMSDOS goes in after reset, as the shell's bootRoms does.
  if (model === 'cpc464' && over.ddi1) m.memory.setUpperRom(7, rom('amsdos.rom'));
  for (let f = 0; f < frames; f++) m.tick();
  return m;
}

describe.skipIf(!has('os6128.rom', 'basic1-1.rom', 'amsdos.rom'))('6128 firmware with the board links', () => {
  it('names the distributor from LK1–LK3 in the sign-on banner', () => {
    const m = boot('cpc6128', { manufacturerCode: 5 });
    expect(m.ocrScreenForMcp()).toContain('Schneider 128K Microcomputer');
  });

  it('programs a 262-line 60 Hz frame when LK4 is open', () => {
    expect(boot('cpc6128', {}).crtc.linesPerFrame()).toBe(312);
    expect(boot('cpc6128', { fiftyHz: false }).crtc.linesPerFrame()).toBe(262);
  });
});

describe.skipIf(!has('os6128.rom', 'basic1-1.rom', 'amsdos.rom'))('6128 with a 256K RAM expansion, from BASIC', () => {
  it('POKEs block 2 through OUT &7F00 and PEEKs it back; the base RAM keeps its own byte', () => {
    const m = boot('cpc6128', { ramExpansionKb: 256 });
    // 32512 = &7F00; 212 = %11 010 100 (block 2, configuration 4: its first
    // bank at &4000); 192 = configuration 0.
    type(m, 'out 32512,212:poke 16384,123:out 32512,192:print peek(16384)\n');
    for (let f = 0; f < 20; f++) m.tick();
    type(m, 'out 32512,212:print peek(16384):out 32512,192\n');
    for (let f = 0; f < 20; f++) m.tick();
    expect(m.memory.getRamBank(4 + 2 * 4)[0]).toBe(123);
    expect(m.memory.getRamBank(1)[0]).not.toBe(123);
    const lines = m.ocrScreenForMcp().split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const results = lines.filter(l => /^\d+$/.test(l));
    expect(results).toEqual([String(m.memory.getRamBank(1)[0]), '123']);
  });
});

describe.skipIf(!has('os464.rom', 'basic1-0.rom', 'amsdos.rom'))('464 with a DDI-1', () => {
  it('boots BASIC 1.0 with AMSDOS, lists a disk with |DIR and saves to it', () => {
    const m = boot('cpc464', { ddi1: true });
    expect(m.ocrScreenForMcp()).toContain('BASIC 1.0');
    const data = DISK_FORMATS.find((f) => f.label === 'CPC Data')!;
    m.loadDisk(createBlankDisk(data), 0);
    type(m, 'save"zx\n');
    for (let f = 0; f < 100; f++) m.tick();
    type(m, '|dir\n');
    for (let f = 0; f < 100; f++) m.tick();
    const dir = m.ocrScreenForMcp();
    expect(dir).toContain('Drive A: user  0');
    expect(dir).toMatch(/ZX {6}\.BAS/);
  });

  it('without the DDI-1 |DIR is an unknown command', () => {
    const m = boot('cpc464', {});
    type(m, '|dir\n');
    for (let f = 0; f < 20; f++) m.tick();
    expect(m.ocrScreenForMcp()).toContain('Unknown command');
  });
});
