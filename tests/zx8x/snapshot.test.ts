/**
 * ZX80/ZX81 snapshots: zx84's native `.zx8xstate` — exact resume, refusal of
 * damaged files and of a RAM pack or graphics board the machine does not
 * have, and the service/menu wiring.
 *
 * The exact-resume checks run on a small synthetic ROM that keeps RAM, the
 * display-file pointer, the ZX81 NMI generator and the A6 /INT all moving,
 * and on the real ZX81 ROM when it is to hand (mcp/.cache/zx81-v2.rom or
 * ZX81_ROM), where the CPU itself generates the picture.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import type { Zx8xModel } from '@/machines/zx8x/models.ts';
import { expectDamagedRefused, expectExactResume, observe } from '../machines/native-state-harness.ts';

const ZX81_ROM = process.env.ZX81_ROM ?? join(import.meta.dirname, '../../mcp/.cache/zx81-v2.rom');

/**
 * 0000 DI; LD SP,4400h; IM 1; OUT (FEh),A (ZX81: NMI generator on); EI
 * 0009 LD HL,4000h
 * 000C loop: INC (HL); INC HL; until H = 44h; then LD HL,4000h; IN A,(FEh); JR loop
 * 0038 /INT (A6 low on refresh): EI; RET
 * 0066 NMI: EX AF,AF'; INC A; EX AF,AF'; RETN
 */
function syntheticRom(): Uint8Array {
  const rom = new Uint8Array(0x1000);
  rom.set([
    0xF3, 0x31, 0x00, 0x44, 0xED, 0x56, 0xD3, 0xFE, 0xFB,
    0x21, 0x00, 0x40,
    0x34, 0x23, 0x7C, 0xFE, 0x44, 0x20, 0xF9,
    0x21, 0x00, 0x40, 0xDB, 0xFE, 0x18, 0xF2,
  ], 0);
  rom.set([0xFB, 0xC9], 0x38);
  rom.set([0x08, 0x3C, 0x08, 0xED, 0x45], 0x66);
  return rom;
}

/**
 * A ROM that keeps every add-on busy: it selects and writes AY registers on
 * the ZON X-81 ports, drives the printer's stylus and reads its status back
 * into E, fills the Chroma 81's RAM and rewrites its control port, then reads
 * the keyboard port (which starts the vertical sync).
 *
 * 0000 DI; LD SP,4400h; LD HL,C000h; LD A,0; OUT (FBh),A
 * 000B loop: LD A,L; AND 0Fh; OUT (CFh),A; LD A,L; OUT (0Fh),A
 *            LD A,L; AND 80h; OUT (FBh),A; IN A,(FBh); XOR E; LD E,A; LD (HL),A
 *            LD A,L; AND 30h; LD BC,7FEFh; OUT (C),A; INC HL; IN A,(FEh); JR loop
 */
function addOnRom(): Uint8Array {
  const rom = new Uint8Array(0x2000);
  rom.set([
    0xF3, 0x31, 0x00, 0x44, 0x21, 0x00, 0xC0, 0x3E, 0x00, 0xD3, 0xFB,
    0x7D, 0xE6, 0x0F, 0xD3, 0xCF, 0x7D, 0xD3, 0x0F,
    0x7D, 0xE6, 0x80, 0xD3, 0xFB, 0xDB, 0xFB, 0xAB, 0x5F, 0x77,
    0x7D, 0xE6, 0x30, 0x01, 0xEF, 0x7F, 0xED, 0x79, 0x23, 0xDB, 0xFE, 0x18, 0xE1,
  ], 0);
  return rom;
}

const ADD_ONS = { 'zx8x-zonx': true, 'zx81-zx-printer': true, 'zx81-chroma81': true };

function machine(model: Zx8xModel, rom: Uint8Array, settings: Record<string, boolean> = {}): Zx8xMachine {
  const m = new Zx8xMachine(model);
  m.start = async () => {};
  m.prepare({ get: <T>(key: string, fallback: T): T => (key in settings ? settings[key] as T : fallback) });
  m.loadROM(rom);
  m.reset();
  return m;
}

function scramble(m: Zx8xMachine): void {
  for (let a = 0x4000; a < 0x8000; a++) m.memory.writeByte(a, a * 13);
  m.cpu.pc = 0x0123;
  m.cpu.i = 0x2f;
}

describe('ZX80/ZX81 .zx8xstate', () => {
  it('is offered for saving and loading on both models', () => {
    for (const model of ['zx80', 'zx81'] as const) {
      const m = machine(model, syntheticRom());
      try {
        expect(m.services.snapshots.formats()).toEqual([{ ext: '.zx8xstate', canSave: true }]);
        expect(m.services.media.accepts()).toContainEqual({ ext: '.zx8xstate', target: 'snapshot' });
        expect(m.descriptor.ui.saveMenu).toContain('snapshot-zx8xstate');
      } finally {
        m.destroy();
      }
    }
  });

  it('resumes exactly on a ZX81 (synthetic ROM, NMI generator and /INT running)', async () => {
    await expectExactResume({
      make: () => machine('zx81', syntheticRom()), ext: '.zx8xstate', before: 31, after: 17, scramble,
    });
  });

  it('resumes exactly on a ZX80 with the 16K pack (synthetic ROM)', async () => {
    await expectExactResume({
      make: () => machine('zx80', syntheticRom(), { 'zx8x-16k-ram': true }),
      ext: '.zx8xstate', before: 23, after: 13, scramble,
    });
  });

  it('resumes exactly on a ZX81 with UDG RAM (synthetic ROM)', async () => {
    await expectExactResume({
      make: () => machine('zx81', syntheticRom(), { 'zx81-udg-ram': true }),
      ext: '.zx8xstate', before: 9, after: 9,
    });
  });

  it.skipIf(!existsSync(ZX81_ROM))('resumes exactly on the ZX81 ROM at the BASIC prompt', async () => {
    const rom = new Uint8Array(readFileSync(ZX81_ROM));
    await expectExactResume({
      make: () => machine('zx81', rom, { 'zx8x-16k-ram': true }),
      ext: '.zx8xstate', before: 150, after: 60, scramble,
    });
  });

  it('refuses a damaged file and leaves the machine alone', async () => {
    await expectDamagedRefused(() => machine('zx81', syntheticRom()), '.zx8xstate');
  });

  it('refuses a state from another RAM size, changing nothing', async () => {
    const src = machine('zx81', syntheticRom(), { 'zx8x-16k-ram': true });
    const dst = machine('zx81', syntheticRom());
    try {
      for (let f = 0; f < 4; f++) src.tick();
      for (let f = 0; f < 6; f++) dst.tick();
      const before = observe(dst);
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.zx8xstate'), 'x.zx8xstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/16K of RAM.*1K.*fit the 16K RAM pack/);
      expect(observe(dst)).toEqual(before);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('refuses a state from another graphics board, changing nothing', async () => {
    const src = machine('zx81', syntheticRom(), { 'zx81-wrx-hires': true });
    const dst = machine('zx81', syntheticRom(), { 'zx81-udg-ram': true });
    try {
      for (let f = 0; f < 3; f++) src.tick();
      for (let f = 0; f < 5; f++) dst.tick();
      const before = observe(dst);
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.zx8xstate'), 'x.zx8xstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/WRX RAM.*the UDG board/);
      expect(observe(dst)).toEqual(before);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('a ZX80 state offered to a ZX81 asks for the ZX80, or is refused headless', async () => {
    const src = machine('zx80', syntheticRom());
    const dst = machine('zx81', syntheticRom());
    try {
      src.tick();
      const result = await dst.services.media.mount(await src.services.snapshots.save('.zx8xstate'), 'x.zx8xstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/for the ZX80/);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('resumes exactly with the ZON X-81, ZX Printer and Chroma 81 fitted and busy', async () => {
    await expectExactResume({
      make: () => machine('zx81', addOnRom(), ADD_ONS), ext: '.zx8xstate', before: 41, after: 23,
    });
  });

  it('restores the state of each add-on: AY registers, printout, Chroma RAM and control', async () => {
    const src = machine('zx81', addOnRom(), ADD_ONS);
    const dst = machine('zx81', addOnRom(), ADD_ONS);
    try {
      for (let f = 0; f < 60; f++) src.tick();
      const file = await src.services.snapshots.save('.zx8xstate');
      for (let f = 0; f < 30; f++) src.tick();
      for (let f = 0; f < 7; f++) dst.tick();
      const result = await dst.services.snapshots.apply(file, 'x.zx8xstate');
      expect(result.ok, result.message).toBe(true);
      for (let f = 0; f < 30; f++) dst.tick();
      // The busy ROM must have produced something to compare.
      expect(src.printer.rowCount).toBeGreaterThan(1);
      expect(src.chroma.ram.some(b => b !== 0)).toBe(true);
      expect(Array.from(dst.ay.getRegisters())).toEqual(Array.from(src.ay.getRegisters()));
      expect(Array.from(dst.printer.paperRows())).toEqual(Array.from(src.printer.paperRows()));
      expect(Array.from(dst.chroma.ram)).toEqual(Array.from(src.chroma.ram));
      expect(dst.chroma.control).toBe(src.chroma.control);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('refuses a state saved with an add-on this machine does not have, changing nothing', async () => {
    const src = machine('zx81', addOnRom(), ADD_ONS);
    const dst = machine('zx81', addOnRom(), { 'zx81-chroma81': true });
    try {
      for (let f = 0; f < 4; f++) src.tick();
      for (let f = 0; f < 6; f++) dst.tick();
      const before = observe(dst);
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.zx8xstate'), 'x.zx8xstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/ZON X-81 and ZX Printer fitted/);
      expect(observe(dst)).toEqual(before);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });
});
