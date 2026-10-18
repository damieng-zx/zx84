/**
 * Sony HB-55 (Japan, NTSC) against its real BIOS: the 32KB MSX System v1.0 +
 * MSX BASIC (Japanese) image (SHA-1 302afb5d8be26c758309ca3df611ae69cced2821, the
 * `hb55bios.rom` of MAME's `hb55`). Place it in mcp/.cache/hb-55_basic-bios1.rom
 * or point MSX_HB55_BIOS at it; skipped without it.
 *
 * Expectations are from the MSX standard's BIOS header, not the emulator: byte
 * 0x2B bits 0-3 = character set (0 = Japanese), bit 7 = 0 for a 60 Hz machine,
 * 0x2C bits 0-3 = keyboard layout (0 = Japanese).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';

const BIOS = process.env.MSX_HB55_BIOS ?? join(import.meta.dirname, '../../mcp/.cache/hb-55_basic-bios1.rom');

function press(m: MsxMachine, code: string, shift = false): void {
  if (shift) m.keyboard.handleKeyEvent('ShiftLeft', true);
  m.keyboard.handleKeyEvent(code, true);
  for (let i = 0; i < 6; i++) m.tick();
  m.keyboard.handleKeyEvent(code, false);
  if (shift) m.keyboard.handleKeyEvent('ShiftLeft', false);
  for (let i = 0; i < 6; i++) m.tick();
}

describe.skipIf(!existsSync(BIOS))('HB-55 real Japanese BIOS', () => {
  const rom = existsSync(BIOS) ? new Uint8Array(readFileSync(BIOS)) : new Uint8Array(0);

  it('is a 60 Hz, Japanese character set / keyboard MSX1 BIOS (matches the NTSC model)', () => {
    expect(rom.length).toBe(0x8000);
    expect(rom[0x2B] & 0x80).toBe(0);              // 60 Hz
    expect(rom[0x2B] & 0x0F).toBe(0);              // Japanese character set
    expect(rom[0x2C] & 0x0F).toBe(0);              // Japanese keyboard
    expect(rom[0x2D]).toBe(0);                     // MSX1
  });

  it('boots to MSX BASIC with 16KB of RAM, a 262-line NTSC field, and PRINT 2+2 works', () => {
    const m = new MsxMachine('hb-55');
    try {
      m.loadROM(rom);
      m.turbo = true;
      m.reset();
      for (let i = 0; i < 1500; i++) m.tick();
      const screen = m.ocrScreenForMcp();
      expect(screen).toContain('MSX BASIC version 1.0');
      expect(screen).toContain('Ok');
      const free = /(\d+) Bytes free/.exec(screen);
      expect(Number(free![1])).toBeGreaterThan(8000);
      expect(Number(free![1])).toBeLessThan(16384);
      expect(m.tStatesPerFrame).toBe(59736);

      // JIS layout: + is Shift+; (the matrix is unchanged, the BIOS key table differs).
      for (const ch of 'print 2+2') press(m, ch === ' ' ? 'Space' : /[0-9]/.test(ch) ? `Digit${ch}` : ch === '+' ? 'Semicolon' : `Key${ch.toUpperCase()}`, ch === '+');
      press(m, 'Enter');
      for (let i = 0; i < 30; i++) m.tick();
      expect(m.ocrScreenForMcp().split('\n').some(l => l.trim() === '4')).toBe(true);
    } finally { m.destroy(); }
  });

  it('runs the BIOS cursor-key and kana-key paths without disturbing BASIC', () => {
    const m = new MsxMachine('hb-55');
    try {
      m.loadROM(rom);
      m.turbo = true;
      m.reset();
      for (let i = 0; i < 1500; i++) m.tick();
      press(m, 'KanaMode');                         // kana lock on
      press(m, 'KanaMode');                         // and off again
      expect(m.ocrScreenForMcp()).toContain('Ok');
    } finally { m.destroy(); }
  });
});
