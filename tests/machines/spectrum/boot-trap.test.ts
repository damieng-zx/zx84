/**
 * Library auto-boot trap PC — the ROM key-wait loop the one-shot trap fires on.
 *
 * The +2A/+3 boot menu waits in ROM 0 on
 *   E5 21 3B 5C CB 6E 28 FC   PUSH HL; LD HL,FLAGS; BIT 5,(HL); JR Z,-4
 * spinning on BIT 5,(HL), whose address differs per ROM revision:
 *   plus3-0.rom    (v4.0)          0x1871 → 0x1875
 *   plus3-41-0.rom (v4.1)          0x1876 → 0x187A
 *   plus3-0-es.rom (Spanish, also loaded by '+2A-es')  0x188D → 0x1891
 * The ROM-backed cases need the images under mcp/.cache/ (not
 * redistributable) and are skipped per file when absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { blankTrdDisk } from '@/media/floppy/trd-image.ts';
import { bootWaitPc, findPlus3MenuWait } from '@/machines/spectrum/boot-trap.ts';

const CACHE = resolve(__dirname, '../../../mcp/.cache');
const have = (names: string[]): boolean => names.every((n) => existsSync(resolve(CACHE, n)));
const romSet = (names: string[]): Uint8Array => {
  const out = new Uint8Array(names.length * 0x4000);
  names.forEach((n, i) => out.set(readFileSync(resolve(CACHE, n)), i * 0x4000));
  return out;
};

const MENU_WAIT = [0xE5, 0x21, 0x3B, 0x5C, 0xCB, 0x6E, 0x28, 0xFC];

describe('findPlus3MenuWait', () => {
  it('returns the BIT 5,(HL) the loop jumps back to', () => {
    const rom0 = new Uint8Array(0x4000);
    rom0.set(MENU_WAIT, 0x1234);
    expect(findPlus3MenuWait(rom0)).toBe(0x1238);
  });

  it('returns -1 for a ROM 0 without the sequence', () => {
    expect(findPlus3MenuWait(new Uint8Array(0x4000))).toBe(-1);
  });
});

describe('bootWaitPc', () => {
  const blank = new Uint8Array(0x4000);

  it('falls back to the v4.1 address on a +2A/+3 ROM 0 without the loop', () => {
    expect(bootWaitPc('zx128kplus2a', blank)).toBe(0x187A);
    expect(bootWaitPc('zx128kplus3', blank)).toBe(0x187A);
  });

  it('keeps the 128K/+2 menu wait and the 48K WAIT-KEY', () => {
    expect(bootWaitPc('zx128k', blank)).toBe(0x0E65);
    expect(bootWaitPc('zx128kplus2', blank)).toBe(0x0E65);
    expect(bootWaitPc('zx48k', blank)).toBe(0x15DE);
    expect(bootWaitPc('zx16k', blank)).toBe(0x15DE);
    expect(bootWaitPc('pentagon128', blank)).toBe(0x0E65);
  });

  it('finds the Scorpion menu wait by its byte pattern, and falls back to the v2.5c address', () => {
    // The ZS-256 menu spins on the same PUSH HL / BIT 5,(HL) loop as the +3.
    const rom0 = new Uint8Array(0x4000);
    rom0.set(MENU_WAIT, 0x367F);
    expect(bootWaitPc('scorpion256', rom0)).toBe(0x3683);
    rom0.fill(0);
    rom0.set(MENU_WAIT, 0x2000);
    expect(bootWaitPc('scorpion256', rom0)).toBe(0x2004);
    expect(bootWaitPc('scorpion256', blank)).toBe(0x3683);
  });

  it('follows a Pentagon-branded ROM, whose menu waits in the +3-style loop', () => {
    const rom0 = new Uint8Array(0x4000);
    rom0.set(MENU_WAIT, 0x367F);
    expect(bootWaitPc('pentagon128', rom0)).toBe(0x3683);
    expect(bootWaitPc('pentagon512', rom0)).toBe(0x3683);
    expect(bootWaitPc('pentagon1024', blank)).toBe(0x0E65);
  });
});

describe('armBootTrap("trdos")', () => {
  it('waits at the 128K menu first on a Pentagon, then at the 48K editor', () => {
    const spec = new Spectrum('pentagon128', null);
    spec.armBootTrap('trdos');
    expect(spec.bootTrapKind).toBe('trdos-menu');
    expect(spec.bootTrapPc).toBe(0x0E65);
  });

  it('goes straight to the editor on a machine with no menu', () => {
    const spec = new Spectrum('zx48k', null);
    spec.armBootTrap('trdos');
    expect(spec.bootTrapKind).toBe('trdos-run');
    expect(spec.bootTrapPc).toBe(0x15DE);
  });

  it('is cleared by reset', () => {
    const spec = new Spectrum('pentagon128', null);
    spec.armBootTrap('trdos');
    spec.reset();
    expect(spec.bootTrapPc).toBe(-1);
    expect(spec.bootTrapKind).toBe('menu');
  });
});

describe.skipIf(!have(['128-0.rom', '128-1.rom', 'trdos.rom']))('TR-DOS auto-boot against the real ROMs', () => {
  it('Pentagon: selects 48 BASIC unlocked, calls TR-DOS at 0x3D00 and types RUN', () => {
    const spec = new Spectrum('pentagon128', null);
    spec.loadROM(romSet(['128-0.rom', '128-1.rom']));
    spec.betaDisk.loadROM(new Uint8Array(readFileSync(resolve(CACHE, 'trdos.rom'))));
    spec.betaDisk.enabled = true;
    spec.loadBetaDiskDisk(blankTrdDisk(80, 2), 0);
    spec.reset();
    let pageIns = 0;
    const pageIn = spec.betaDisk.pageIn.bind(spec.betaDisk);
    spec.betaDisk.pageIn = (m) => { if (!spec.betaDisk.pagedIn) pageIns++; pageIn(m); };
    spec.armBootTrap('trdos');
    // The sequence arrives in two stages: the menu trap hands over to the editor trap.
    for (let f = 0; f < 150 && spec.bootTrapKind === 'trdos-menu'; f++) spec.runUntil(1);
    expect(spec.bootTrapKind).toBe('trdos-run');
    for (let f = 0; f < 600; f++) spec.runUntil(1);
    expect(spec.bootTrapPc).toBe(-1);                       // the editor trap fired
    expect(spec.memory.currentROM).toBe(1);                 // 48 BASIC was chosen
    expect(spec.memory.pagingLocked).toBe(false);           // unlike the menu, which locks it
    expect(spec.bootTrapKind).toBe('trdos-ready');          // the CALL got TR-DOS back to the editor
    expect(pageIns).toBeGreaterThanOrEqual(2);              // the CALL, then RUN
  });

  it('a 48K Spectrum with no Beta Disk fitted never jumps into ROM at 0x3D00', () => {
    const spec = new Spectrum('zx48k', null);
    spec.loadROM(new Uint8Array(readFileSync(resolve(CACHE, '128-1.rom'))));
    spec.reset();
    spec.armBootTrap('trdos');
    for (let f = 0; f < 400; f++) spec.runUntil(1);
    expect(spec.bootTrapPc).toBe(-1);                       // the editor trap fired…
    expect(spec.bootTrapKind).toBe('trdos-run');            // …but found nothing to call
  });
});

const SETS: { name: string; model: 'zx128kplus2a' | 'zx128kplus3'; roms: string[]; pc: number }[] = [
  { name: 'v4.0 (plus3-*.rom)', model: 'zx128kplus3',
    roms: ['plus3-0.rom', 'plus3-1.rom', 'plus3-2.rom', 'plus3-3.rom'], pc: 0x1875 },
  { name: 'v4.1 (plus3-41-*.rom)', model: 'zx128kplus2a',
    roms: ['plus3-41-0.rom', 'plus3-41-1.rom', 'plus3-41-2.rom', 'plus3-41-3.rom'], pc: 0x187A },
  { name: 'v4.1 on a +3 (the app aliases +3 ROMs to +2A)', model: 'zx128kplus3',
    roms: ['plus3-41-0.rom', 'plus3-41-1.rom', 'plus3-41-2.rom', 'plus3-41-3.rom'], pc: 0x187A },
  { name: 'Spanish (plus3-*-es.rom)', model: 'zx128kplus2a',
    roms: ['plus3-0-es.rom', 'plus3-1-es.rom', 'plus3-2-es.rom', 'plus3-3-es.rom'], pc: 0x1891 },
];

describe('+2A/+3 auto-boot trap against real ROMs', () => {
  for (const s of SETS) {
    describe.skipIf(!have(s.roms))(s.name, () => {
      it(`arms at ${s.pc.toString(16)} and the boot menu reaches it`, () => {
        const spec = new Spectrum(s.model, null);
        spec.loadROM(romSet(s.roms));
        spec.reset();
        spec.armBootTrap('menu');
        expect(spec.bootTrapPc).toBe(s.pc);
        // The trap is one-shot: it disarms (-1) once the menu's key-wait runs.
        for (let f = 0; f < 300 && spec.bootTrapPc >= 0; f++) spec.runUntil(1);
        expect(spec.bootTrapPc).toBe(-1);
      });
    });
  }
});
