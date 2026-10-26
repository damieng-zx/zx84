/**
 * Currah µSpeech in a running 48K Spectrum: the ROM pages itself in on the frame
 * interrupt, sets up BASIC's RAMTOP, and `LET s$="…"` is spoken through the SP0256.
 *
 * Needs three images under mcp/.cache/ (none are redistributable), skipped without
 * them: 48.rom, currah-uspeech.rom and sp0256-al2.rom.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';

const CACHE = resolve(__dirname, '../../../mcp/.cache');
const NAMES = ['48.rom', 'currah-uspeech.rom', 'sp0256-al2.rom'];
const have = NAMES.every((n) => existsSync(resolve(CACHE, n)));
const img = (n: string): Uint8Array => new Uint8Array(readFileSync(resolve(CACHE, n)));

function boot(fitted: boolean): { s: Spectrum; out: number[] } {
  const s = new Spectrum('zx48k', null);
  s.loadROM(img('48.rom'));
  s.currah.enabled = fitted;
  s.currah.loadROM(img('currah-uspeech.rom'));
  s.currah.loadSpeechROM(img('sp0256-al2.rom'));
  s.reset();
  const out: number[] = [];
  (s.audio as unknown as { pushSample(l: number, r: number): void }).pushSample = (l) => { out.push(l); };
  return { s, out };
}

function frames(s: Spectrum, n: number): void { for (let i = 0; i < n; i++) s.tick(); }

function tap(s: Spectrum, code: string, key?: string, mods: string[] = []): void {
  for (const m of mods) s.keyboard.handleKeyEvent(m, true);
  s.keyboard.handleKeyEvent(code, true, key);
  frames(s, 3);
  s.keyboard.handleKeyEvent(code, false, key);
  for (const m of mods) s.keyboard.handleKeyEvent(m, false);
  frames(s, 3);
}

/** LET s$="HELLO" */
function sayHello(s: Spectrum): void {
  tap(s, 'KeyL');
  tap(s, 'KeyS');
  tap(s, 'Digit4', undefined, ['ShiftRight']);
  tap(s, 'Equal', '=');
  tap(s, 'Quote', '"');
  for (const ch of 'HELLO') tap(s, `Key${ch}`);
  tap(s, 'Quote', '"');
  tap(s, 'Enter');
}

const ramtop = (s: Spectrum): number => s.memory.readByte(0x5CB2) | (s.memory.readByte(0x5CB3) << 8);

describe.skipIf(!have)('Currah µSpeech in a 48K Spectrum', () => {
  it('leaves a stock 48K untouched when not fitted', () => {
    const { s } = boot(false);
    frames(s, 150);
    expect(s.currah.pagedIn).toBe(false);
    expect(ramtop(s)).toBe(0xFF57);     // stock RAMTOP, just below the UDGs
  });

  it('pages its ROM in on the first interrupt and reserves the top of RAM', () => {
    const { s } = boot(true);
    frames(s, 150);
    // The ROM claims the top page of RAM for its speech buffer by lowering RAMTOP 256 bytes.
    expect(ramtop(s)).toBe(0xFE57);
    // It is out again by the time the interrupt routine has returned to BASIC.
    expect(s.currah.pagedIn).toBe(false);
    expect(s.memory.flat[0x0038]).toBe(0xF5);      // the Spectrum ROM's PUSH AF is back
    expect(s.memory.flat[0x0100]).toBe(img('48.rom')[0x0100]);
  });

  it('speaks LET s$="HELLO" through the SP0256 and keeps BASIC running', () => {
    const { s, out } = boot(true);
    frames(s, 150);
    sayHello(s);
    const start = out.length;
    frames(s, 150);
    const speech = out.slice(start);
    expect(speech.length).toBeGreaterThan(0);
    // Silence would mean nothing was sent to the chip; the beeper is idle in BASIC.
    expect(Math.max(...speech.map(Math.abs))).toBeGreaterThan(0.02);
    expect(s.currah.chip.ready).toBe(true);
  });

  it('is silent with the same input when not fitted', () => {
    const { s, out } = boot(false);
    frames(s, 150);
    sayHello(s);
    const start = out.length;
    frames(s, 150);
    expect(Math.max(0, ...out.slice(start).map(Math.abs))).toBeLessThan(0.02);
  });
});
