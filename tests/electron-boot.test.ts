/**
 * Headless Acorn Electron boot against the real OS and BASIC ROMs.
 *
 * The ROMs are not redistributable. Place them in mcp/.cache as
 * `electron-basic.rom` (16K, the BASIC II image) and `electron-os.rom` (16K,
 * the OS); the suite is skipped when they are absent. Expectations are the
 * sign-on of the Electron User Guide: "Acorn Electron", "BASIC" and the `>`
 * prompt, then BASIC arithmetic and a SAVE / LOAD round trip on tape.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ElectronMachine } from '@/machines/electron/electron-machine.ts';
import { parseAdfs } from '@/media/floppy/adfs.ts';

const CACHE = resolve(__dirname, '../mcp/.cache');
const haveRoms = ['electron-basic.rom', 'electron-os.rom'].every(r => existsSync(resolve(CACHE, r)));

function boot(): ElectronMachine {
  const rom = new Uint8Array(0x8000);
  rom.set(readFileSync(resolve(CACHE, 'electron-basic.rom')), 0);
  rom.set(readFileSync(resolve(CACHE, 'electron-os.rom')), 0x4000);
  const m = new ElectronMachine('electron', null);
  m.loadROM(rom);
  m.reset();
  for (let i = 0; i < 200; i++) m.tick();
  return m;
}

function typist(m: ElectronMachine): (s: string) => void {
  return (s) => {
    for (const ch of s) {
      const ev = {
        code: ch === '\n' ? 'Enter' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : '',
        key: ch === '\n' ? 'Enter' : ch, shift: false, ctrl: false, alt: false,
      };
      m.services.input.keyDown(ev);
      for (let i = 0; i < 3; i++) m.tick();
      m.services.input.keyUp(ev);
      for (let i = 0; i < 3; i++) m.tick();
    }
  };
}

const run = (m: ElectronMachine, frames: number): void => { for (let i = 0; i < frames; i++) m.tick(); };

describe.skipIf(!haveRoms)('Acorn Electron with the real OS and BASIC', () => {
  it('boots to the BASIC prompt', () => {
    const m = boot();
    const text = m.ocrScreenForMcp();
    expect(text).toContain('Acorn Electron');
    expect(text).toContain('BASIC');
    expect(text).toMatch(/^>/m);
    m.destroy();
  }, 60_000);

  it('runs BASIC from the keyboard', () => {
    const m = boot();
    typist(m)('PRINT 6*7\n');
    run(m, 30);
    expect(m.ocrScreenForMcp()).toMatch(/^\s*42$/m);
    m.destroy();
  }, 60_000);

  it('SAVEs a program to tape and LOADs it back from the recording', async () => {
    const a = boot();
    const typeA = typist(a);
    typeA('10 PRINT "HELLO TAPE"\nSAVE "HI"\n');
    run(a, 20);
    typeA('\n');                                      // "RECORD then RETURN"
    run(a, 3000);
    const rec = a.services.tape.recordedBytes();
    expect(rec).not.toBeNull();
    a.destroy();

    const b = boot();
    const typeB = typist(b);
    expect(await b.services.tape.mountBytes(rec!.data, 'rec.uef')).toBe(true);
    typeB('LOAD "HI"\n');
    run(b, 6000);
    typeB('RUN\n');
    run(b, 30);
    expect(b.ocrScreenForMcp()).toMatch(/^HELLO TAPE$/m);
    b.destroy();
  }, 180_000);
});

// ── Plus 1 / Plus 3 with the real expansion ROMs ───────────────────────────
// `electron-plus1.rom` (Expansion 1.00, 8K) and `electron-plus3.rom` (ADFS 1.00,
// 16K) also live in mcp/.cache. The disc is any 640K ADFS L image: point
// ZX84_ADL at one (the suite skips the disc test without it).

const haveExpansions = haveRoms && ['electron-plus1.rom', 'electron-plus3.rom']
  .every(r => existsSync(resolve(CACHE, r)));
const ADL = process.env.ZX84_ADL
  ?? 'E:/retro/Acorn/BBC/Emulators/BeebEm/UserData/DiscIms/L3FS-ISW.adl';
const haveAdl = haveExpansions && existsSync(ADL);

function bootWith(plus1: boolean, plus3: boolean): ElectronMachine {
  const rom = new Uint8Array(0x8000);
  rom.set(readFileSync(resolve(CACHE, 'electron-basic.rom')), 0);
  rom.set(readFileSync(resolve(CACHE, 'electron-os.rom')), 0x4000);
  const m = new ElectronMachine('electron', null);
  m.loadROM(rom);
  m.setExpansions(plus1, plus3);
  if (plus1) m.installPlus1Rom(new Uint8Array(readFileSync(resolve(CACHE, 'electron-plus1.rom'))));
  if (plus3) m.installPlus3Rom(new Uint8Array(readFileSync(resolve(CACHE, 'electron-plus3.rom'))));
  m.reset();
  for (let i = 0; i < 250; i++) m.tick();
  return m;
}

describe.skipIf(!haveExpansions)('Electron Plus 1 and Plus 3 with the real ROMs', () => {
  it('announces the Plus 3 ADFS at start-up and the Plus 1 in *HELP', () => {
    const m = bootWith(true, true);
    expect(m.ocrScreenForMcp()).toContain('Acorn ADFS');
    typist(m)('*HELP\n');
    run(m, 60);
    expect(m.ocrScreenForMcp()).toMatch(/Expansion 1\.00/);
    m.destroy();
  }, 60_000);

  it('leaves the plain machine alone when neither is fitted', () => {
    const m = bootWith(false, false);
    expect(m.ocrScreenForMcp()).not.toContain('ADFS');
    m.destroy();
  }, 60_000);

  it.skipIf(!haveAdl)('catalogues an ADFS L disc and loads a file that crosses a track boundary', () => {
    const m = bootWith(false, true);
    m.services.disks.insert('a', parseAdfs(new Uint8Array(readFileSync(ADL)), true), 'disc.adl');
    const type = typist(m);
    type('*DIR $\n');
    run(m, 600);                                  // the OS reads no keys while it owns the controller
    type('*CAT\n');
    run(m, 1500);
    expect(m.ocrScreenForMcp()).toMatch(/Drive:0/);
    // !ReadMe starts at logical sector 7 and runs to ~51, over three tracks: the
    // ADFS L logical-sector order must be what the controller addresses.
    const image = readFileSync(ADL);
    type('*LOAD !ReadMe 3000\n');
    run(m, 4000);
    const len = 0x2BC1;
    expect(Array.from(m.memory.ram.subarray(0x3000, 0x3000 + len)))
      .toEqual(Array.from(image.subarray(7 * 256, 7 * 256 + len)));
    m.destroy();
  }, 120_000);
});
