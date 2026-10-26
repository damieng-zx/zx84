/**
 * Sony HB-55P (European HB-55: PAL, 16KB Personal Data Bank ROM).
 *
 * The real-firmware tests need the BIOS (32768 bytes, SHA-1 8963fc04...) and the
 * Data Bank ROM (16384 bytes, SHA-1 b262aedc...) in mcp/.cache, or via
 * MSX_HB55P_BIOS / MSX_HB55P_FIRMWARE; they are skipped without them.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';
import { isMsxModel } from '@/machines/msx/models.ts';
import { entryForModel } from '@/machines/registry.ts';
import type { SettingsView } from '@/machines/machine.ts';

const BIOS = process.env.MSX_HB55P_BIOS ?? join(import.meta.dirname, '../../mcp/.cache/hb-55p_basic-bios1.rom');
const FW = process.env.MSX_HB55P_FIRMWARE ?? join(import.meta.dirname, '../../mcp/.cache/hb-55p_firmware.rom');
const view: SettingsView = { get: (_key: string, def: unknown) => def } as SettingsView;

function press(m: MsxMachine, code: string, shift = false): void {
  if (shift) m.keyboard.handleKeyEvent('ShiftLeft', true);
  m.keyboard.handleKeyEvent(code, true);
  for (let i = 0; i < 6; i++) m.tick();
  m.keyboard.handleKeyEvent(code, false);
  if (shift) m.keyboard.handleKeyEvent('ShiftLeft', false);
  for (let i = 0; i < 6; i++) m.tick();
}

describe('HB-55P config', () => {
  it('is PAL with a 16KB firmware page and its own hosted names', () => {
    const m = new MsxMachine('hb-55p');
    try {
      expect(isMsxModel('hb-55p')).toBe(true);
      expect(m.tStatesPerFrame).toBe(71591);
      expect(m.config.linesPerFrame).toBe(313);
      expect(entryForModel('hb-55p').romSources('hb-55p')).toEqual(['msx/hb-55p_basic-bios1.rom']);
      expect(m.prepare(view).map(r => r.source)).toEqual(['msx/hb-55p_firmware.rom']);
      const fw = new Uint8Array(0x4000); fw[0x3FFF] = 0x6C;
      m.loadFirmware(fw);
      expect(m.memory.readByte(0xBFFF)).toBe(0x6C);       // the whole 0x8000-0xBFFF page
      expect(m.prepare(view)).toEqual([]);
    } finally { m.destroy(); }
  });
});

describe.skipIf(!existsSync(BIOS))('HB-55P real BIOS', () => {
  function boot(withFirmware: boolean): MsxMachine {
    const m = new MsxMachine('hb-55p');
    m.loadROM(new Uint8Array(readFileSync(BIOS)));
    if (withFirmware) m.loadFirmware(new Uint8Array(readFileSync(FW)));
    m.turbo = true;
    m.reset();
    for (let i = 0; i < 1500; i++) m.tick();
    return m;
  }

  it('boots to MSX BASIC with 16KB of RAM (no Data Bank ROM) and PRINT 2+2 works', () => {
    const m = boot(false);
    try {
      const screen = m.ocrScreenForMcp();
      expect(screen).toContain('MSX BASIC version 1.0');
      expect(screen).toContain('Ok');
      const free = /(\d+) Bytes free/.exec(screen);
      expect(Number(free![1])).toBeGreaterThan(8000);
      expect(Number(free![1])).toBeLessThan(16384);
      for (const ch of 'print 2+2') press(m, ch === ' ' ? 'Space' : /[0-9]/.test(ch) ? `Digit${ch}` : ch === '+' ? 'Equal' : `Key${ch.toUpperCase()}`, ch === '+');
      press(m, 'Enter');
      for (let i = 0; i < 30; i++) m.tick();
      expect(m.ocrScreenForMcp().split('\n').some(l => l.trim() === '4')).toBe(true);
    } finally { m.destroy(); }
  });

  it.skipIf(!existsSync(FW))('with the Data Bank ROM it boots to the Data Bank menu; its BASIC entry reaches the prompt', () => {
    const m = boot(true);
    try {
      expect(m.vdp.mode()).not.toBe('text');              // the graphical menu, not the BASIC banner
      for (let i = 0; i < 4; i++) press(m, 'ArrowDown');  // Address, Schedule, Memo, Transfer -> BASIC
      press(m, 'Enter');
      for (let i = 0; i < 400; i++) m.tick();
      const screen = m.ocrScreenForMcp();
      expect(screen).toContain('MSX BASIC version 1.0');
      expect(screen).toContain('Ok');
    } finally { m.destroy(); }
  });
});
