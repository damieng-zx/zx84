/**
 * Headless Atari boots with the real OS and BASIC, through the real frame
 * loop: the 800 (BASIC cartridge) and each XL (built-in BASIC, or the
 * cartridge on the 1200XL).
 *
 * Needs Atari's own OS and BASIC images, which are not redistributable and
 * which the emulator does not ship (it runs AltirraOS; see altirra-boot.test.ts).
 * They are looked up in ATARI_ROM_DIR, else mcp/.cache/, as atariosb.rom,
 * atari800xl.rom, ataribas.rom, ... The XL images are also found under their common dump names
 * (REV01.ROM = 600XL, REV02.ROM = 800XL, REV10.ROM = 1200XL). Each case is
 * skipped when its images are absent.
 *
 * Expectations (Atari BASIC Reference Manual, ch. 1; OS User's Manual):
 * BASIC signs on with READY on a GRAPHICS 0 screen whose playfield is the OS
 * default COLOR2 ($94, blue) with COLOR1 ($CA) luminance text; typed keys go
 * through POKEY's keyboard IRQ, so `PRINT 2+2` answering 4 proves the IRQ
 * path end to end.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { buildAtariPalette } from '@/machines/atari/palette.ts';
import { atariInfo, type AtariModel } from '@/machines/atari/models.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

const DIR = process.env.ATARI_ROM_DIR ?? resolve(__dirname, '../../mcp/.cache');
const BASIC = resolve(DIR, 'ataribas.rom');
/** OS image names to try per model: the ROM-host name, then the dump name. */
const OS_NAMES: Record<AtariModel, readonly string[]> = {
  atari400: ['atariosb.rom'],
  atari800: ['atariosb.rom'],
  atari600xl: ['atari600xl.rom', 'REV01.ROM'],
  atari800xl: ['atari800xl.rom', 'REV02.ROM'],
  atari1200xl: ['atari1200xl.rom', 'REV10.ROM'],
  // The XE line runs the 800XL's OS.
  atari65xe: ['atari800xl.rom', 'REV02.ROM'],
  atari800xe: ['atari800xl.rom', 'REV02.ROM'],
  atari130xe: ['atari800xl.rom', 'REV02.ROM'],
};
function osPath(model: AtariModel): string | null {
  for (const n of OS_NAMES[model]) {
    const p = resolve(DIR, n);
    if (existsSync(p)) return p;
  }
  return null;
}
const OS = osPath('atari800') ?? '';
const haveRoms = OS !== '' && existsSync(BASIC);

/** ANTIC internal screen code to ASCII (the low 7 bits; bit 7 is inverse). */
function screenText(m: AtariMachine): string[] {
  const savmsc = m.memory.readByte(0x58) | (m.memory.readByte(0x59) << 8);
  const rows: string[] = [];
  for (let r = 0; r < 24; r++) {
    let s = '';
    for (let c = 0; c < 40; c++) {
      const v = m.memory.readByte(savmsc + r * 40 + c) & 0x7f;
      const a = v < 0x40 ? v + 0x20 : v < 0x60 ? v - 0x40 : v;
      s += a >= 0x20 && a < 0x7f ? String.fromCharCode(a) : ' ';
    }
    rows.push(s.trimEnd());
  }
  return rows;
}

function keyEvent(ch: string): HostKeyEvent {
  const base = { shift: false, ctrl: false, alt: false };
  if (ch === '\n') return { code: 'Enter', key: 'Enter', ...base };
  if (ch === ' ') return { code: 'Space', key: ' ', ...base };
  if (/[A-Z]/.test(ch)) return { code: `Key${ch}`, key: ch.toLowerCase(), ...base };
  if (/[0-9]/.test(ch)) return { code: `Digit${ch}`, key: ch, ...base };
  return { code: 'Equal', key: ch, ...base };
}

function type(m: AtariMachine, text: string): void {
  for (const ch of text) {
    const e = keyEvent(ch);
    m.keyDown(e);
    for (let f = 0; f < 3; f++) m.tick();
    m.keyUp(e);
    for (let f = 0; f < 3; f++) m.tick();
  }
}

describe.skipIf(!haveRoms)('Atari 800 headless boot (OS-B + BASIC)', { timeout: 30_000 }, () => {
  it.each(['ntsc', 'pal'] as const)('boots %s to READY on a blue GRAPHICS 0 screen and answers PRINT 2+2', (region) => {
    const m = new AtariMachine('atari800', null, region);
    try {
      m.services.roms.installSystemRom(new Uint8Array(readFileSync(OS)));
      m.services.roms.cartridge!.insert(new Uint8Array(readFileSync(BASIC)), '');
      m.setSpeedMultiplier(0);
      for (let f = 0; f < 120; f++) m.tick();

      expect(screenText(m).map(r => r.trim())).toContain('READY');

      // Buffer row 40 is inside the first text row's band; x 200 is mid-screen
      // and blank, so it shows the COLPF2 field. x 4 is the COLBK border.
      const palette = buildAtariPalette(region === 'pal', 'tv', '800');
      const px = new Uint32Array(m.pixels.buffer);
      expect(px[40 * 336 + 200]).toBe(palette[0x94]);
      expect(px[40 * 336 + 4]).toBe(palette[0x00]);

      type(m, 'PRINT 2+2\n');
      for (let f = 0; f < 10; f++) m.tick();
      const rows = screenText(m);
      const cmd = rows.findIndex(r => r.trim() === 'PRINT 2+2');
      expect(cmd).toBeGreaterThanOrEqual(0);
      expect(rows[cmd + 1].trim()).toBe('4');
    } finally {
      m.destroy();
    }
  });
});

const XL_MODELS = ['atari600xl', 'atari800xl', 'atari1200xl'] as const;

describe.each(XL_MODELS)('Atari %s headless boot', { timeout: 30_000 }, (model) => {
  const os = osPath(model);
  it.skipIf(!os || !existsSync(BASIC))('boots to READY and answers PRINT 2+2', () => {
    const m = new AtariMachine(model, null, 'pal');
    try {
      const osRom = new Uint8Array(readFileSync(os!));
      const basic = new Uint8Array(readFileSync(BASIC));
      if (atariInfo(model).builtinBasic) {
        // The system image is the OS followed by the internal BASIC.
        m.services.roms.installSystemRom(new Uint8Array([...osRom, ...basic]));
      } else {
        m.services.roms.installSystemRom(osRom);
        m.services.roms.cartridge!.insert(basic, '');
      }
      m.reset(); // as the shell does after installing the system ROM
      m.setSpeedMultiplier(0);
      for (let f = 0; f < 150; f++) m.tick();
      expect(screenText(m).map(r => r.trim())).toContain('READY');

      type(m, 'PRINT 2+2\n');
      for (let f = 0; f < 10; f++) m.tick();
      const rows = screenText(m);
      const cmd = rows.findIndex(r => r.trim() === 'PRINT 2+2');
      expect(rows[cmd + 1].trim()).toBe('4');
    } finally {
      m.destroy();
    }
  });

  it.skipIf(!os || !atariInfo(model).builtinBasic)('switches BASIC off when OPTION is held through power-on', () => {
    const m = new AtariMachine(model, null, 'pal');
    try {
      const osRom = new Uint8Array(readFileSync(os!));
      const basic = existsSync(BASIC) ? new Uint8Array(readFileSync(BASIC)) : new Uint8Array(0x2000);
      m.services.roms.installSystemRom(new Uint8Array([...osRom, ...basic]));
      const option = { code: 'F4', key: 'F4', shift: false, ctrl: false, alt: false };
      m.keyDown(option);
      m.reset();
      m.setSpeedMultiplier(0);
      for (let f = 0; f < 60; f++) m.tick();
      m.keyUp(option);
      for (let f = 0; f < 60; f++) m.tick();
      // PORTB bit 1 high: BASIC out. With no cartridge or disk the XL OS then
      // runs its self-test, from the ROM it maps at $5000.
      expect(m.memory.basicRomEnabled).toBe(false);
      expect(m.memory.selfTestRomEnabled).toBe(true);
      expect(m.cpu.pc >= 0x5000 && m.cpu.pc < 0x5800).toBe(true);
    } finally {
      m.destroy();
    }
  });
});
