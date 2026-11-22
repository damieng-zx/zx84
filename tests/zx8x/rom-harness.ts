/**
 * Headless drive of the real ZX81 ROM for the cassette, printer and colour
 * tests: boot, press keys, read the screen. Needs zx81-v2.rom in
 * ZX8X_ROM_DIR or mcp/.cache (the tests skip without it).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import type { Zx8xModel } from '@/machines/zx8x/models.ts';

const DIR = process.env.ZX8X_ROM_DIR ?? resolve(__dirname, '../../mcp/.cache');
export const ZX81_ROM_PATH = resolve(DIR, 'zx81-v2.rom');
export const haveZx81Rom = existsSync(ZX81_ROM_PATH);

export type Key = string | string[];
export type Settings = Record<string, boolean>;

/** A ZX81 (or another ZX81-ROM model) booted to the BASIC prompt with the given settings. */
export function boot(settings: Settings = {}, model: Zx8xModel = 'zx81'): Zx8xMachine {
  const m = new Zx8xMachine(model);
  m.prepare({ get: <T>(key: string, fallback: T): T => (key in settings ? settings[key] as T : fallback) });
  m.loadROM(new Uint8Array(readFileSync(ZX81_ROM_PATH)));
  m.reset();
  // With 16K of RAM the ROM's cold start runs to roughly frame 400 (the 1K and
  // 2K machines are at the prompt well inside 200), and typing before the prompt
  // is up loses keys.
  const frames = m.memory.has16kExpansion ? 450 : 200;
  for (let f = 0; f < frames; f++) m.tick();
  return m;
}

/** Press and release one key (a chord when given an array). */
export function press(m: Zx8xMachine, codes: Key): void {
  const keys = Array.isArray(codes) ? codes : [codes];
  for (const k of keys) m.keyboard.handleKeyEvent(k, true);
  for (let f = 0; f < 6; f++) m.tick();
  for (const k of [...keys].reverse()) m.keyboard.handleKeyEvent(k, false);
  for (let f = 0; f < 6; f++) m.tick();
}

export function type(m: Zx8xMachine, seq: Key[]): void {
  for (const k of seq) press(m, k);
  for (let f = 0; f < 30; f++) m.tick();
}

/** FNV-1a over the system variables and the program, display and edit-line
 *  area (E_LINE plus the report line below it), leaving out FRAMES, which ticks
 *  every frame. It changes while the ROM is still working and holds still at the
 *  BASIC prompt. */
function basicStateKey(m: Zx8xMachine): number {
  const end = Math.min(0x8000, word(m, 0x4014) + 0x60);
  let h = 0x811c9dc5;
  for (let a = 0x4000; a < end; a++) {
    if (a === 0x4034 || a === 0x4035) continue;
    h = Math.imul(h ^ m.memory.readByte(a), 0x01000193);
  }
  return h >>> 0;
}

/** Run frames until the BASIC state has not changed for `quiet` frames in a row
 *  (the ROM back at its prompt), or `limit` frames pass; returns frames used.
 *  A 16K machine and a 60 Hz one both take different numbers of frames to
 *  finish the same keystroke, so waiting a fixed count loses keys. */
export function settle(m: Zx8xMachine, quiet = 20, limit = 3000): number {
  let still = 0;
  let last = basicStateKey(m);
  let f = 0;
  for (; f < limit && still < quiet; f++) {
    m.tick();
    const now = basicStateKey(m);
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return f;
}

export const QUOTE: Key = ['ShiftLeft', 'KeyP'];   // ZX81: SHIFT+P is "

export function screen(m: Zx8xMachine): string {
  const mem = new Uint8Array(0x10000);
  for (let a = 0; a < 0x10000; a++) mem[a] = m.memory.readByte(a);
  return m.screenText.ocr(mem, m.model);
}

export const word = (m: Zx8xMachine, a: number): number => m.memory.readByte(a) | (m.memory.readByte(a + 1) << 8);
export const ram = (m: Zx8xMachine, from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => m.memory.readByte(from + i));

/** Run frames until `done()` or `limit` frames pass; returns frames used. */
export function runUntil(m: Zx8xMachine, done: () => boolean, limit: number): number {
  let f = 0;
  while (f < limit && !done()) { m.tick(); f++; }
  return f;
}

/** 10 PRINT 42, as a real user types it. */
export function enterPrint42(m: Zx8xMachine): void {
  type(m, ['Digit1', 'Digit0', 'KeyP', 'Digit4', 'Digit2', 'Enter']);
}
