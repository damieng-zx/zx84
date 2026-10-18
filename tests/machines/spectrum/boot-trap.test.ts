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
    expect(bootWaitPc('+2A', blank)).toBe(0x187A);
    expect(bootWaitPc('+3', blank)).toBe(0x187A);
  });

  it('keeps the 128K/+2 menu wait and the 48K WAIT-KEY', () => {
    expect(bootWaitPc('128k', blank)).toBe(0x0E65);
    expect(bootWaitPc('+2', blank)).toBe(0x0E65);
    expect(bootWaitPc('48k', blank)).toBe(0x15DE);
    expect(bootWaitPc('16k', blank)).toBe(0x15DE);
  });
});

const SETS: { name: string; model: '+2A' | '+3'; roms: string[]; pc: number }[] = [
  { name: 'v4.0 (plus3-*.rom)', model: '+3',
    roms: ['plus3-0.rom', 'plus3-1.rom', 'plus3-2.rom', 'plus3-3.rom'], pc: 0x1875 },
  { name: 'v4.1 (plus3-41-*.rom)', model: '+2A',
    roms: ['plus3-41-0.rom', 'plus3-41-1.rom', 'plus3-41-2.rom', 'plus3-41-3.rom'], pc: 0x187A },
  { name: 'v4.1 on a +3 (the app aliases +3 ROMs to +2A)', model: '+3',
    roms: ['plus3-41-0.rom', 'plus3-41-1.rom', 'plus3-41-2.rom', 'plus3-41-3.rom'], pc: 0x187A },
  { name: 'Spanish (plus3-*-es.rom)', model: '+2A',
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
