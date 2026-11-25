/**
 * CPC keyboard typing against the real 6128 firmware.
 *
 * The CPC's UK key legends are not the PC's: `+` is Shift+`;`, `|` is Shift+`@`
 * (the key left of Z), `:` is unshifted on its own key, and the `= +` key
 * carries `↑`/`£`. Sending the PC physical chord therefore types the wrong
 * character into BASIC, and `RUN"DISC`-style commands never execute.
 *
 * These tests type through the production InputService character-intent path
 * and read back what the firmware actually evaluated, so they pin real keyboard
 * behaviour rather than a mapping table's own logic.
 *
 * Needs the firmware ROMs under mcp/.cache/; skipped when absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

const CACHE = resolve(__dirname, '../../mcp/.cache');
const ROMS = ['os6128.rom', 'basic1-1.rom', 'amsdos.rom'];
const haveRoms = ROMS.every((r) => existsSync(resolve(CACHE, r)));
const rom = (n: string): Uint8Array => new Uint8Array(readFileSync(resolve(CACHE, n)));

function booted(): CpcMachine {
  const m = new CpcMachine('cpc6128', null);
  m.memory.loadRoms(rom('os6128.rom'), rom('basic1-1.rom'), rom('amsdos.rom'));
  m.memory.setUpperRom(7, rom('amsdos.rom'));
  m.reset();
  m.runUntil(150);
  return m;
}

/** Type a string through the production character-intent keyboard path. */
function typeText(m: CpcMachine, s: string): void {
  const input = m.services.input;
  for (const ch of s) {
    const upper = ch >= 'A' && ch <= 'Z';
    const code = ch === '\n' ? 'Enter'
      : /[a-zA-Z]/.test(ch) ? 'Key' + ch.toUpperCase()
        : /[0-9]/.test(ch) ? 'Digit' + ch
          : ch === ' ' ? 'Space' : '';
    const event: HostKeyEvent = { code, key: ch === '\n' ? 'Enter' : ch, shift: upper, ctrl: false, alt: false };
    input.keyDown(event);
    for (let f = 0; f < 2; f++) m.tick();
    input.keyUp(event);
    for (let f = 0; f < 3; f++) m.tick();
  }
}

function screen(m: CpcMachine): string[] {
  return m.ocrScreenForMcp().split('\n').slice(1).map(t => t.replace(/\s+$/, ''));
}

/** The echo line under the last "Ready" — the live input line before Enter. */
function inputLine(m: CpcMachine): string {
  const lines = screen(m);
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() === 'Ready') last = i;
  return (lines[last + 1] ?? '').trim();
}

describe.skipIf(!haveRoms)('CPC character-intent typing on the real 6128 firmware', () => {
  it('types the CPC legend characters the PC layout would get wrong', () => {
    const m = booted();
    // Every one of these differs between a PC keyboard and a CPC one.
    typeText(m, '+*|@:;=<>,.');
    const echoed = inputLine(m);
    expect(echoed).toBe('+*|@:;=<>,.');
    m.destroy();
  });

  it('evaluates a BASIC expression using CPC-only symbol positions', () => {
    const m = booted();
    typeText(m, 'print 2+3*4\n');
    m.runUntil(40);
    const lines = screen(m);
    // Locomotive BASIC right-aligns integers in a numeric field, so the result
    // line reads " 14" with trailing blanks. 14 proves `+` and `*` both parsed.
    expect(lines.some(l => l.trim() === '14')).toBe(true);
    expect(lines.some(l => /Syntax error/i.test(l))).toBe(false);
    m.destroy();
  });

  it('types a quoted string with | and @ inside it', () => {
    const m = booted();
    typeText(m, 'print "a|b@c"\n');
    m.runUntil(40);
    expect(screen(m).some(l => l.trim() === 'a|b@c')).toBe(true);
    m.destroy();
  });
});
