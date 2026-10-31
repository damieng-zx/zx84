/**
 * Headless drive of the real ZX81 ROM for the cassette, printer and colour
 * tests: boot, press keys, read the screen. Needs zx81-v2.rom in
 * ZX8X_ROM_DIR or mcp/.cache (the tests skip without it).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';

const DIR = process.env.ZX8X_ROM_DIR ?? resolve(__dirname, '../../mcp/.cache');
export const ZX81_ROM_PATH = resolve(DIR, 'zx81-v2.rom');
export const haveZx81Rom = existsSync(ZX81_ROM_PATH);

export type Key = string | string[];
export type Settings = Record<string, boolean>;

/** A ZX81 booted to the BASIC prompt with the given settings. */
export function boot(settings: Settings = {}): Zx8xMachine {
  const m = new Zx8xMachine('zx81');
  m.prepare({ get: <T>(key: string, fallback: T): T => (key in settings ? settings[key] as T : fallback) });
  m.loadROM(new Uint8Array(readFileSync(ZX81_ROM_PATH)));
  m.reset();
  for (let f = 0; f < 200; f++) m.tick();
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
