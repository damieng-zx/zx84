/**
 * Headless Atari boots on the firmware the emulator ships: AltirraOS (the
 * 10K 400/800 build and the 16K XL/XE build) with Altirra BASIC, through the
 * real frame loop.
 *
 * These are every model's default OS and BASIC (models.ts
 * `ALTIRRA_*_SOURCE`); none of Atari's own images are fetched. The images are
 * redistributable (each source file carries the FSF all-permissive notice)
 * but are not checked in: they are looked up by their ROM-host names in
 * ATARI_ROM_DIR, then in mcp/.cache/ where the MCP server caches them. Each
 * case is skipped when its images are absent.
 *
 * Expectations (Altirra BASIC's cartridge cold start, atbasic.s `main`): the
 * cartridge prints its banner "Altirra 8K BASIC <version>" and then `Ready`
 * (msg_ready: mixed case, unlike Atari BASIC's READY).
 * Typed keys go through POKEY's keyboard IRQ into the OS's E: handler, so
 * `PRINT 2+2` answering 4 proves the IRQ, CIO and the floating-point path
 * (AltirraOS's own math pack at $D800) end to end.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import {
  ALTIRRA_BASIC_SOURCE, ALTIRRA_OS_SOURCE, ALTIRRA_XL_OS_SOURCE, ATARI_MODELS,
  atariInfo, type AtariModel,
} from '@/machines/atari/models.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

const DIRS = [
  process.env.ATARI_ROM_DIR,
  resolve(__dirname, '../../mcp/.cache'),
].filter((d): d is string => !!d);

/** A ROM-host source's image, from the first folder that has it. */
function image(source: string): Uint8Array | null {
  const name = source.split('/').pop()!;
  for (const dir of DIRS) {
    const p = resolve(dir, name);
    if (existsSync(p)) return new Uint8Array(readFileSync(p));
  }
  return null;
}

const OS_800 = image(ALTIRRA_OS_SOURCE);
const OS_XL = image(ALTIRRA_XL_OS_SOURCE);
const BASIC = image(ALTIRRA_BASIC_SOURCE);

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

describe.each(ATARI_MODELS)('Atari %s on AltirraOS + Altirra BASIC', { timeout: 30_000 }, (model: AtariModel) => {
  const info = atariInfo(model);
  const os = info.xl ? OS_XL : OS_800;

  it.skipIf(!os || !BASIC).each(['ntsc', 'pal'] as const)('boots %s to Ready and answers PRINT 2+2', (region) => {
    const m = new AtariMachine(model, null, region);
    try {
      if (info.builtinBasic) {
        // The system image is the OS followed by the internal BASIC.
        m.services.roms.installSystemRom(new Uint8Array([...os!, ...BASIC!]));
      } else {
        m.services.roms.installSystemRom(os!);
        m.services.roms.cartridge!.insert(BASIC!, '');
      }
      m.reset(); // as the shell does after installing the system ROM
      m.setSpeedMultiplier(0);
      for (let f = 0; f < 150; f++) m.tick();

      const boot = screenText(m).map(r => r.trim());
      expect(boot.some(r => r.startsWith('Altirra 8K BASIC'))).toBe(true);
      expect(boot).toContain('Ready');

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

describe('Atari 130XE extended RAM from BASIC', { timeout: 30_000 }, () => {
  it.skipIf(!OS_XL || !BASIC)('keeps a POKE in the bank it was written to', () => {
    const m = new AtariMachine('atari130xe', null, 'pal');
    try {
      m.services.roms.installSystemRom(new Uint8Array([...OS_XL!, ...BASIC!]));
      m.reset();
      m.setSpeedMultiplier(0);
      for (let f = 0; f < 150; f++) m.tick();

      // PORTB ($D301 = 54017): $FD is the boot state (OS in, BASIC in, banks
      // out); clearing bit 4 gives the CPU bank 0, adding bit 2 gives bank 1.
      type(m, 'POKE 54017,237:POKE 20000,77:POKE 54017,233:POKE 20000,88\n');
      type(m, 'POKE 54017,253:PRINT PEEK(20000)\n');
      type(m, 'POKE 54017,237:PRINT PEEK(20000)\n');
      type(m, 'POKE 54017,233:PRINT PEEK(20000):POKE 54017,253\n');
      for (let f = 0; f < 30; f++) m.tick();
      const answers = screenText(m).map(r => r.trim()).filter(r => /^\d+$/.test(r));
      expect(answers).toEqual(['0', '77', '88']);
    } finally {
      m.destroy();
    }
  });
});

describe.each(['atari800', 'atari800xl'] as const)('BASIC panes on Altirra BASIC (%s)', { timeout: 30_000 }, (model) => {
  const xl = model === 'atari800xl';
  it.skipIf(!(xl ? OS_XL : OS_800) || !BASIC)('list the program and show its variables', () => {
    const m = new AtariMachine(model, null, 'pal');
    try {
      const os = (xl ? OS_XL : OS_800)!;
      if (xl) m.services.roms.installSystemRom(new Uint8Array([...os, ...BASIC!]));
      else {
        m.services.roms.installSystemRom(os);
        m.services.roms.cartridge!.insert(BASIC!, '');
      }
      m.reset();
      m.setSpeedMultiplier(0);
      for (let f = 0; f < 150; f++) m.tick();
      const panes = m.services.probe.panes;

      type(m, '10 DIM A$(12),B(5)\n20 A$="ATARI":B(1)=7\n30 X=355/113\nRUN\n');
      for (let f = 0; f < 60; f++) m.tick();
      expect(panes.basicListing!().map(l => `${l.lineNumber} ${l.text}`)).toEqual([
        '10 DIM A$(12),B(5)',
        '20 A$="ATARI":B(1)=7',
        '30 X=355/113',
      ]);
      const vars = panes.basicVars!();
      expect(vars.find(v => v.name === 'A$')).toMatchObject({ kind: 'string', value: 'ATARI' });
      expect(vars.find(v => v.name === 'B(5)')?.kind).toBe('array');
      expect(vars.find(v => v.name === 'X')).toMatchObject({ kind: 'number' });
      expect(vars.find(v => v.name === 'X')!.value).toMatch(/^3\.141592/);
    } finally {
      m.destroy();
    }
  });
});
