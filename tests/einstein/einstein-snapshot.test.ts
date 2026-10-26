/**
 * Tatung Einstein snapshots: zx84's native `.einstate` on the TC-01 and the
 * Einstein 256 — exact resume, the disks a saved file carries, refusal of
 * damaged files and of a drive count the machine does not have.
 *
 * No MOS ROM is to hand, so the exact-resume checks run a synthetic ROM that
 * keeps every part of the board moving: CTC channel 3 interrupting in IM 2
 * about ten times a frame (the handler steps a counter into the PSG), the main
 * loop streaming bytes into VRAM, and the WD1770 reading sector 1 over and over
 * one polled byte per loop pass into RAM — so a frame boundary lands part-way
 * through a transfer, which a restore has to carry on from the same byte.
 */

import { describe, it, expect } from 'vitest';
import { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import type { SettingsView } from '@/machines/machine.ts';
import type { DskImage, DskSector, DskTrack } from '@/media/floppy/disk-image.ts';
import type { EinsteinModel } from '@/models.ts';
import { expectDamagedRefused, expectExactResume, observe } from '../machines/native-state-harness.ts';

function program(): Uint8Array {
  const rom = new Uint8Array(0x4000);
  rom.set([
    0xF3,                   // 0000 DI
    0x31, 0x00, 0xF0,       // 0001 LD SP,F000h
    0x3E, 0x80, 0xED, 0x47, // 0004 LD A,80h; LD I,A
    0xED, 0x5E,             // 0008 IM 2
    0x21, 0x40, 0x00,       // 000A LD HL,0040h
    0x22, 0x06, 0x80,       // 000D LD (8006h),HL   CTC ch3 vector (base 0)
    0x3E, 0x00, 0xD3, 0x28, // 0010 vector base 0
    0x3E, 0xA5, 0xD3, 0x2B, // 0014 ch3: interrupt, timer, /256, TC follows
    0x3E, 0x20, 0xD3, 0x2B, // 0018 time constant 32
    0x3E, 0x40, 0xD3, 0x09, 0x3E, 0x81, 0xD3, 0x09, // 001C VDP R1 = 40h (display on)
    0x3E, 0x14, 0xD3, 0x09, 0x3E, 0x87, 0xD3, 0x09, // 0024 VDP R7 = 14h
    0x3E, 0x00, 0xD3, 0x09, 0x3E, 0x40, 0xD3, 0x09, // 002C VRAM write address 0
    0x3E, 0x01, 0xD3, 0x23, // 0034 drive 0, side 0
    0xC3, 0x80, 0x00,       // 0038 JP 0080h
  ], 0);
  rom.set([
    0xF5,                   // 0040 PUSH AF
    0x3A, 0x01, 0x90,       // 0041 LD A,(9001h)
    0x3C,                   // 0044 INC A
    0x32, 0x01, 0x90,       // 0045 LD (9001h),A
    0xD3, 0x02, 0xD3, 0x03, // 0048 select PSG register A, write A to it
    0xF1, 0xFB, 0xED, 0x4D, // 004C POP AF; EI; RETI
  ], 0x40);
  rom.set([
    0x21, 0x00, 0x90,       // 0080 LD HL,9000h
    0x11, 0x00, 0xA0,       // 0083 LD DE,A000h
    0xFB,                   // 0086 EI
    0x34,                   // 0087 loop: INC (HL)
    0x7E, 0xD3, 0x08,       // 0088 LD A,(HL); OUT (08h),A   (VRAM stream)
    0xDB, 0x18,             // 008B IN A,(18h)   FDC status
    0xCB, 0x4F, 0x20, 0x0E, // 008D BIT 1,A; JR NZ,data
    0xCB, 0x47, 0x20, 0xF2, // 0091 BIT 0,A; JR NZ,loop
    0x3E, 0x01, 0xD3, 0x1A, // 0095 sector 1
    0x3E, 0x80, 0xD3, 0x18, // 0099 READ SECTOR
    0x18, 0xE8,             // 009D JR loop
    0xDB, 0x1B,             // 009F data: IN A,(1Bh)
    0x12, 0x13,             // 00A1 LD (DE),A; INC DE
    0xCB, 0xA2,             // 00A3 RES 4,D   (keep DE in A000h-AFFFh)
    0x18, 0xE0,             // 00A5 JR loop
  ], 0x80);
  return rom;
}

const view = (values: Record<string, unknown> = {}): SettingsView => ({
  get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; },
});

/** 40 single-sided tracks of ten 512-byte sectors, each byte telling where it is. */
function disk(): DskImage {
  const tracks: (DskTrack | null)[][] = [];
  for (let c = 0; c < 40; c++) {
    const sectors: DskSector[] = [];
    const sectorMap = new Map<number, number>();
    for (let r = 1; r <= 10; r++) {
      const data = new Uint8Array(512);
      for (let i = 0; i < data.length; i++) data[i] = (c * 31 + r * 7 + i) & 0xFF;
      sectorMap.set(r, sectors.length);
      sectors.push({ c, h: 0, r, n: 2, st1: 0, st2: 0, data });
    }
    tracks.push([{ sectors, sectorMap, gap3: 82, filler: 0xE5 }]);
  }
  return { format: 'extended', numTracks: 40, numSides: 1, tracks, diskFormat: 'Einstein', protection: '' };
}

function machine(model: EinsteinModel, opts: { drives?: number; disk?: boolean } = {}): EinsteinMachine {
  const m = new EinsteinMachine(model, null);
  m.start = async () => {};
  m.prepare(view(opts.drives === undefined ? {} : { 'drive-count:einstein': opts.drives }));
  const rom = program();
  m.loadROM(model === 'einstein-256' ? rom : rom.subarray(0, 0x2000));
  m.reset();
  if (opts.disk) m.services.disks.insert('a', disk(), 'work.dsk');
  return m;
}

/** Put a machine somewhere else: scribbled RAM and VRAM, a different pc. */
function scramble(m: EinsteinMachine): void {
  for (let a = 0x8000; a < 0x10000; a++) m.memory.writeByte(a, a * 13);
  m.vdp.vram.fill(0x5A);
  m.cpu.pc = 0x0087;
}

describe('Einstein .einstate', () => {
  it('is offered for saving and loading on both models', () => {
    for (const model of ['einstein-tc01', 'einstein-256'] as const) {
      const m = machine(model);
      try {
        expect(m.services.snapshots.formats()).toEqual([{ ext: '.einstate', canSave: true }]);
        expect(m.services.media.accepts().map(t => t.ext)).toContain('.einstate');
        expect(m.descriptor.ui.saveMenu).toContain('snapshot-einstate');
      } finally {
        m.destroy();
      }
    }
  });

  it('the synthetic program really is mid-transfer at a frame boundary', () => {
    const m = machine('einstein-tc01', { disk: true });
    try {
      let midTransfer = 0;
      for (let f = 0; f < 20; f++) {
        m.tick();
        if (m.fdc.drq) midTransfer++;
      }
      expect(midTransfer).toBeGreaterThan(0);
      // Sector data has reached RAM: the bytes of sector 1 run up by one.
      const a = m.memory.readByte(0xA100);
      expect(m.memory.readByte(0xA101)).toBe((a + 1) & 0xFF);
      expect(m.memory.readByte(0xA102)).toBe((a + 2) & 0xFF);
    } finally {
      m.destroy();
    }
  });

  it('resumes exactly on the TC-01, a disk transfer in flight', async () => {
    await expectExactResume({
      make: () => machine('einstein-tc01', { disk: true }),
      ext: '.einstate',
      before: 23,
      after: 17,
      scramble,
    });
  });

  it('resumes exactly on the Einstein 256 (V9938), a disk transfer in flight', async () => {
    await expectExactResume({
      make: () => machine('einstein-256', { disk: true }),
      ext: '.einstate',
      before: 19,
      after: 15,
      scramble,
    });
  });

  it('resumes exactly with the drives empty and only one fitted', async () => {
    await expectExactResume({
      make: () => machine('einstein-tc01', { drives: 1 }),
      ext: '.einstate',
      before: 9,
      after: 8,
      scramble,
    });
  });

  it('a saved file carries the disks, their names and what was written to them', async () => {
    const src = machine('einstein-tc01', { disk: true });
    const dst = machine('einstein-tc01');
    try {
      for (let f = 0; f < 5; f++) src.tick();
      src.fdc.getDiskImage(0)!.tracks[3][0]!.sectors[2].data[5] = 0x77;
      src.services.disks.setWriteProtect('a', true);
      const result = await dst.services.media.mount(await src.services.snapshots.save('.einstate'), 'x.einstate');
      expect(result.ok, result.message).toBe(true);
      expect(result.target).toBe('snapshot');
      expect(result.mediaChanged).toBe(true);
      const a = dst.services.disks.drives.find(d => d.id === 'a')!;
      expect(a.loaded).toBe(true);
      expect(a.mediaName).toBe('work.dsk');
      expect(a.writeProtected).toBe(true);
      expect(dst.fdc.getDiskImage(0)!.tracks[3][0]!.sectors[2].data[5]).toBe(0x77);
      expect(dst.fdc.getDiskImage(1)).toBeNull();
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('the refresh copy leaves the drives to the shell', async () => {
    const src = machine('einstein-tc01', { disk: true });
    const dst = machine('einstein-tc01');
    try {
      for (let f = 0; f < 5; f++) src.tick();
      expect(await dst.services.snapshots.restoreSync(src.services.snapshots.saveSync())).toBe(true);
      expect(dst.fdc.getDiskImage(0)).toBeNull();
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('refuses a damaged file and leaves the machine alone', async () => {
    await expectDamagedRefused(() => machine('einstein-tc01', { disk: true }), '.einstate');
  });

  it('refuses a state saved with another drive count, changing nothing', async () => {
    const src = machine('einstein-tc01', { drives: 1 });
    const dst = machine('einstein-tc01', { drives: 2, disk: true });
    try {
      for (let f = 0; f < 4; f++) src.tick();
      for (let f = 0; f < 6; f++) dst.tick();
      const before = observe(dst);
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.einstate'), 'x.einstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/one drive.*2 drives/);
      expect(observe(dst)).toEqual(before);
      expect(dst.services.disks.drives.find(d => d.id === 'a')!.mediaName).toBe('work.dsk');
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('a TC-01 state on a 256 asks the host for the TC-01', async () => {
    const src = machine('einstein-tc01');
    const dst = machine('einstein-256');
    const asked: string[] = [];
    dst.attachHost({
      setStatus: () => {},
      requestModel: async model => { asked.push(model); return true; },
      persistMedia: () => {},
    });
    try {
      src.tick();
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.einstate'), 'x.einstate');
      expect(result).toMatchObject({ ok: true, needsReplay: true });
      expect(asked).toEqual(['einstein-tc01']);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });
});
