/**
 * Headless CPC 6128 boot + AMSDOS disk round-trip smoke test, run through the
 * real frame loop with the Gate Array's 1µs /WAIT timing.
 *
 * Needs the Amstrad firmware ROMs (os6128 / BASIC 1.1 / AMSDOS), which are not
 * redistributable — the MCP server caches them under mcp/.cache/. The suite is
 * skipped when they are absent.
 *
 * Expectations: the 6128 sign-on banner and "Ready" prompt (Amstrad CPC6128
 * User Instructions, ch. 1), and AMSDOS SAVE/CAT listing a saved BASIC file as
 * "<NAME>    .BAS" on a freshly formatted Data-format disk.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { createBlankDisk, DISK_FORMATS } from '@/media/floppy/dsk.ts';

const CACHE = resolve(__dirname, '../../mcp/.cache');
const ROMS = ['os6128.rom', 'basic1-1.rom', 'amsdos.rom'];
const haveRoms = ROMS.every((r) => existsSync(resolve(CACHE, r)));
const rom = (n: string): Uint8Array => new Uint8Array(readFileSync(resolve(CACHE, n)));

const FRAME_T = 19968 * 4;

function screen(m: CpcMachine): string {
  return m.ocrScreenForMcp();
}

function tap(m: CpcMachine, codes: string[]): void {
  for (const c of codes) m.keyboard.handleKeyEvent(c, true);
  for (let f = 0; f < 3; f++) m.tick();
  for (const c of codes) m.keyboard.handleKeyEvent(c, false);
  for (let f = 0; f < 3; f++) m.tick();
}

function type(m: CpcMachine, s: string): void {
  for (const ch of s) {
    if (ch === '"') tap(m, ['ShiftLeft', 'Digit2']);
    else if (ch === '\n') tap(m, ['Enter']);
    else tap(m, ['Key' + ch.toUpperCase()]);
  }
}

describe.skipIf(!haveRoms)('CPC 6128 headless boot (firmware ROMs from mcp/.cache)', () => {
  it('boots to BASIC 1.1 on exact 19968µs frames, then SAVEs and CATs a file on disk', () => {
    const m = new CpcMachine('cpc6128', null);
    m.memory.loadRoms(rom('os6128.rom'), rom('basic1-1.rom'), rom('amsdos.rom'));
    m.reset();
    const t0 = m.cpu.tStates;
    for (let f = 0; f < 150; f++) m.tick();
    // 150 frames on the µs grid: the clock sits within one instruction of the end.
    expect(m.cpu.tStates - t0 - 150 * FRAME_T).toBeGreaterThanOrEqual(0);
    expect(m.cpu.tStates - t0 - 150 * FRAME_T).toBeLessThan(28);
    const boot = screen(m);
    expect(boot).toContain('Amstrad 128K Microcomputer');
    expect(boot).toContain('BASIC 1.1');
    expect(boot).toContain('Ready');

    const data = DISK_FORMATS.find((f) => f.label === 'CPC Data')!;
    m.loadDisk(createBlankDisk(data), 0);
    type(m, 'save"zx\n');
    for (let f = 0; f < 100; f++) m.tick();
    type(m, 'cat\n');
    for (let f = 0; f < 100; f++) m.tick();
    const cat = screen(m);
    expect(cat).toContain('Drive A: user  0');
    expect(cat).toMatch(/ZX {6}\.BAS/);
  });
});
