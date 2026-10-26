/**
 * Enterprise snapshots: zx84's native `.epstate`.
 *
 * Exact resume runs on a small synthetic EXOS-segment program that keeps
 * every part of the machine moving: it pages RAM, builds a four-block line
 * parameter table (16-colour pixels, a VINT border block, VSYNC, a reloading
 * blank block), points Nick at it, starts two Dave tone channels, enables the
 * 50Hz, 1Hz and VINT interrupts and scribbles over the displayed pixels
 * while its IM 1 handler flips a page register and the border. The real
 * EXOS/BASIC/EXDOS set runs too when it is to hand (EP_ROM_DIR, as
 * enterprise-boot.test.ts).
 *
 * The WD1770 is checked mid-transfer by hand: a read and an in-place write
 * caught part-way through must finish the same after a restore.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EnterpriseMachine } from '@/machines/enterprise/enterprise-machine.ts';
import type { EnterpriseModel } from '@/machines/enterprise/models.ts';
import { HostFileBundle } from '@/machines/enterprise/hostfs.ts';
import { buildFatImage } from '@/media/floppy/fat-image.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { expectDamagedRefused, expectExactResume, observe } from '../machines/native-state-harness.ts';

const DIR = process.env.EP_ROM_DIR ?? resolve(__dirname, '../../mcp/.cache');
const ROMS = ['exos21.rom', 'basic21.rom', 'exdos13.rom'];
const haveRoms = ROMS.every(r => existsSync(resolve(DIR, r)));

function syntheticRom(): Uint8Array {
  const rom = new Uint8Array(0x4000);
  rom.set([
    0xF3,                               // DI
    0x3E, 0xFC, 0xD3, 0xB1,             // page 1 = FC (video RAM)
    0x3E, 0xFE, 0xD3, 0xB2,             // page 2 = FE
    0x3E, 0xFF, 0xD3, 0xB3,             // page 3 = FF
    0x31, 0x00, 0x00,                   // LD SP,0
    0x21, 0x00, 0x01, 0x11, 0x00, 0x41, 0x01, 0x40, 0x00, 0xED, 0xB0,  // LPT → video 0100h
    0x3E, 0x10, 0xD3, 0x82,             // LPT base low
    0xAF, 0xD3, 0x83, 0x3E, 0x40, 0xD3, 0x83, 0x3E, 0xC0, 0xD3, 0x83,  // start it
    0x3E, 0x55, 0xD3, 0x81,             // border
    0x3E, 0x1F, 0xD3, 0x80,             // FIXBIAS
    0xC3, 0x40, 0x00,                   // JP 0040h
  ], 0);
  rom.set([0xC3, 0x80, 0x00], 0x38);    // IM 1 → 0080h
  rom.set([
    0x3E, 0x40, 0xD3, 0xA0, 0x3E, 0x01, 0xD3, 0xA1,   // tone 0
    0x3E, 0x20, 0xD3, 0xA8, 0x3E, 0x20, 0xD3, 0xAC,   // volumes
    0x3E, 0x33, 0xD3, 0xA2, 0x3E, 0x12, 0xD3, 0xA3,   // tone 1, 5-bit poly
    0x3E, 0x10, 0xD3, 0xA9,
    0x3E, 0x20, 0xD3, 0xA7,             // sound interrupt from 50Hz
    0x3E, 0x3F, 0xD3, 0xB4,             // enable snd/1Hz/VINT, clear latches
    0xED, 0x56, 0xFB,                   // IM 1; EI
    0x21, 0x00, 0x60,                   // LD HL,6000h
    0x34, 0x23, 0x7C, 0xFE, 0x7F, 0x20, 0x03, 0x21, 0x00, 0x60,  // INC (HL), step, wrap
    0xD3, 0xB5, 0xDB, 0xB5,             // keyboard row out, row in
    0x18, 0xF0,                         // JR loop
  ], 0x40);
  rom.set([
    0xF5, 0xDB, 0xB4, 0x3E, 0x3F, 0xD3, 0xB4,   // PUSH AF; IN A,(B4); ack every latch
    0xDB, 0xB2, 0xEE, 0x03, 0xD3, 0xB2,         // flip page 2 between FD and FE
    0xED, 0x5F, 0xD3, 0x81,                     // border = R
    0xF1, 0xFB, 0xED, 0x4D,                     // POP AF; EI; RETI
  ], 0x80);
  const pal = [0x00, 0x49, 0x92, 0xDB, 0x24, 0x6D, 0xB6, 0xFF];
  rom.set([
    0x38, 0x52, 0x0B, 0x33, 0x00, 0x20, 0x00, 0x00, ...pal,   // 200 lines, 16-colour pixels
    0xCE, 0x8E, 0x3F, 0x3F, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // 50 border lines, VINT
    0xFD, 0x00, 0x3F, 0x3F, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // 3 lines VSYNC
    0xC5, 0x0F, 0x3F, 0x3F, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // 59 lines, RELOAD
  ], 0x100);
  return rom;
}

function view(exdos: boolean) {
  return { get: <T>(key: string, fallback: T): T => (key === 'enterprise-exdos' ? exdos as unknown as T : fallback) };
}

function machine(model: EnterpriseModel = 'ep128', exdos = true): EnterpriseMachine {
  const m = new EnterpriseMachine(model, null);
  m.start = async () => {};
  m.prepare(view(exdos));
  m.loadROM(syntheticRom());
  m.reset();
  return m;
}

function realMachine(): EnterpriseMachine {
  const m = new EnterpriseMachine('ep128', null);
  m.start = async () => {};
  for (const req of m.prepare(view(true))) req.apply(new Uint8Array(readFileSync(resolve(DIR, 'exdos13.rom'))));
  m.loadROM(new Uint8Array([
    ...readFileSync(resolve(DIR, 'exos21.rom')),
    ...readFileSync(resolve(DIR, 'basic21.rom')),
  ]));
  m.reset();
  return m;
}

function disk(fill: number): DskImage {
  const data = new Uint8Array(3000);
  for (let i = 0; i < data.length; i++) data[i] = (i * fill) & 0xFF;
  return buildFatImage([{ name: 'GAME.COM', data }])!.image;
}

const out = (m: EnterpriseMachine, port: number, v: number) => m.cpu.portOutHandler!(port, v);
const inp = (m: EnterpriseMachine, port: number) => m.cpu.portInHandler!(port);

/** Put a target machine somewhere else: RAM, paging, the border, Nick 100
 *  lines further round its table, and the frame-buffer row out of step. */
function scramble(m: EnterpriseMachine): void {
  m.memory.ram.fill(0x5A);
  m.nick.writePort(1, 0x12);
  m.memory.setPage(2, 0xF9);
  for (let i = 0; i < 100; i++) { m.nick.beginLine(); m.nick.endLine(null, 0); }
  // The frame-buffer row the next line lands on (counted from VSYNC).
  (m as unknown as { frameRow: number }).frameRow = 150;
}

describe('Enterprise .epstate', () => {
  it('is offered for saving and loading', () => {
    const m = machine();
    try {
      expect(m.services.snapshots.formats()).toEqual([{ ext: '.epstate', canSave: true }]);
      expect(m.services.media.accepts().some(t => t.ext === '.epstate' && t.target === 'snapshot')).toBe(true);
      expect(m.descriptor.ui.saveMenu).toContain('snapshot-epstate');
    } finally {
      m.destroy();
    }
  });

  it('resumes exactly on the 128 (synthetic program)', async () => {
    await expectExactResume({
      make: () => machine('ep128'),
      ext: '.epstate',
      before: 61,
      after: 37,
      scramble,
    });
  });

  it('draws the very first frame after a restore exactly as the original does', async () => {
    await expectExactResume({ make: () => machine('ep128'), ext: '.epstate', before: 30, after: 1, scramble });
  });

  it('resumes exactly on the 64 without the disk card', async () => {
    await expectExactResume({ make: () => machine('ep64', false), ext: '.epstate', before: 23, after: 19 });
  });

  it.skipIf(!haveRoms)('resumes exactly on EXOS 2.1 with BASIC and EXDOS', async () => {
    await expectExactResume({ make: realMachine, ext: '.epstate', before: 400, after: 100 });
  });

  it('refuses a damaged file and leaves the machine alone', async () => {
    await expectDamagedRefused(() => machine(), '.epstate');
  });

  it('refuses a state saved with the other disk-card setting, changing nothing', async () => {
    const src = machine('ep128', true);
    const dst = machine('ep128', false);
    try {
      for (let f = 0; f < 4; f++) src.tick();
      for (let f = 0; f < 9; f++) dst.tick();
      const before = observe(dst);
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.epstate'), 'x.epstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/EXDOS disk card fitted/);
      expect(observe(dst)).toEqual(before);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('refuses a state from the other model when no host can switch', async () => {
    const src = machine('ep64');
    const dst = machine('ep128');
    try {
      src.tick();
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.epstate'), 'x.epstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Enterprise 64/);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('carries the disks in a saved file, and finishes a read and an in-place write caught part-way', async () => {
    const src = machine();
    const dst = machine();
    try {
      for (let f = 0; f < 5; f++) src.tick();
      src.services.disks.insert('a', disk(3), 'one.img');
      src.services.disks.insert('c', disk(7), 'three.img');
      src.services.disks.setWriteProtect('c', true);
      // Drive A:, side 0, track 0: READ SECTOR 2, take 100 bytes.
      out(src, 0x18, 0x01);
      out(src, 0x11, 0); out(src, 0x12, 2); out(src, 0x10, 0x80);
      for (let i = 0; i < 100; i++) inp(src, 0x13);
      const file = await src.services.snapshots.save('.epstate');

      dst.services.disks.insert('b', disk(9), 'other.img');
      const result = await dst.services.media.mount(file, 'x.epstate');
      expect(result.ok, result.message).toBe(true);
      expect(result.target).toBe('snapshot');
      expect(result.mediaChanged).toBe(true);
      expect(dst.services.disks.drives.map(d => [d.id, d.loaded, d.mediaName, d.writeProtected])).toEqual([
        ['a', true, 'one.img', false], ['b', false, '', false],
        ['c', true, 'three.img', true], ['d', false, '', false],
      ]);
      const rest = (m: EnterpriseMachine) => Array.from({ length: 412 }, () => inp(m, 0x13));
      const expected = rest(src);
      expect(rest(dst)).toEqual(expected);
      expect(inp(dst, 0x10) & 0x01).toBe(0);   // command over

      // WRITE SECTOR 3 on A:, 200 bytes in, saved, the other 312 after.
      out(src, 0x12, 3); out(src, 0x10, 0xA0);
      for (let i = 0; i < 200; i++) out(src, 0x13, i & 0xFF);
      const file2 = await src.services.snapshots.save('.epstate');
      expect((await dst.services.snapshots.apply(file2, 'y.epstate')).ok).toBe(true);
      for (const m of [src, dst]) for (let i = 200; i < 512; i++) out(m, 0x13, (i * 5) & 0xFF);
      const sector = (m: EnterpriseMachine) =>
        Array.from(m.services.disks.image('a')!.tracks[0][0]!.sectors.find(s => s.r === 3)!.data);
      expect(sector(dst)).toEqual(sector(src));
      expect(sector(dst).slice(0, 3)).toEqual([0, 1, 2]);
      expect(sector(dst)[511]).toBe((511 * 5) & 0xFF);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('a refresh state leaves the disks to the shell, which puts them back without a restart', async () => {
    const src = machine();
    const dst = machine();
    try {
      src.services.disks.insert('a', disk(3), 'one.img');
      for (let f = 0; f < 8; f++) src.tick();
      const sync = src.services.snapshots.saveSync();
      expect(await dst.services.snapshots.restoreSync(sync)).toBe(true);
      expect(dst.services.disks.drives[0].loaded).toBe(false);
      const pc = dst.cpu.pc;
      const t = dst.cpu.tStates;
      // The shell remounts the persisted disk through the media service.
      const { serializeFatImage } = await import('@/media/floppy/fat-image.ts');
      const result = await dst.services.media.mount(serializeFatImage(disk(3)), 'one.img', 'a');
      expect(result.ok, result.message).toBe(true);
      expect(dst.services.disks.drives[0].mediaName).toBe('one.img');
      expect(dst.cpu.pc).toBe(pc);
      expect(dst.cpu.tStates).toBe(t);
      expect(dst.typing).toBe(false);
      // A second mount of a disk in A: is a user's, and restarts as usual.
      await dst.services.media.mount(serializeFatImage(disk(3)), 'one.img', 'a');
      expect(dst.cpu.tStates).toBe(0);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('carries the FILE: device, its files and an open channel', async () => {
    const src = machine();
    const dst = machine();
    try {
      const bundle = new HostFileBundle();
      bundle.add('MAIN.COM', Uint8Array.from([1, 2, 3, 4, 5, 6]));
      bundle.add('DATA.BIN', Uint8Array.from([9, 8, 7]));
      bundle.keyFile = 'MAIN.COM';
      src.setFileBundle(bundle);
      for (let f = 0; f < 3; f++) src.tick();
      // Open channel 5 on DATA.BIN and read a byte, as EXOS would.
      const mem = {
        read: (a: number) => (a === 0x1000 ? 8 : 'DATA.BIN'.charCodeAt(a - 0x1001)),
        userRead: () => 0, userWrite: () => {},
      };
      const regs = { a: 5, b: 0, c: 0, d: 0x10, e: 0x00 };
      src.hostFs.perform(1, regs, mem);
      expect(regs.a).toBe(0);
      const sync = src.services.snapshots.saveSync();
      expect(await dst.services.snapshots.restoreSync(sync)).toBe(true);
      expect(dst.fileBundle?.names.sort()).toEqual(['DATA.BIN', 'MAIN.COM']);
      expect(dst.fileBundle?.keyFile).toBe('MAIN.COM');
      expect(dst.memory.isRomSegment(0x10)).toBe(true);
      const read = (m: EnterpriseMachine) => {
        const r = { a: 5, b: 0, c: 0, d: 0, e: 0 };
        m.hostFs.perform(5, r, mem);
        return [r.a, r.b];
      };
      expect(read(dst)).toEqual(read(src));
    } finally {
      src.destroy();
      dst.destroy();
    }
  });
});
