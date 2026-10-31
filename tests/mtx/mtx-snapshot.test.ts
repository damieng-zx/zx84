/**
 * Memotech MTX snapshots: zx84's native `.mtxstate` — exact resume, refusal
 * of damaged files and of hardware the machine does not have fitted, and the
 * disks and ROM pack travelling with the state.
 *
 * The firmware is not to hand, so the checks run a small synthetic OS ROM that
 * keeps everything the state has to carry moving: IM 2 interrupts from two CTC
 * channels (channel 0 counting the VDP frame flag, channel 1 a timer), VDP
 * writes, SN76489 writes through the port 6 latch, RAM paging toggled on every
 * pass, the 80-column card's RAM and an FDX sector read that runs across
 * frame boundaries.
 */

import { describe, it, expect } from 'vitest';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';
import type { MtxModel } from '@/machines/mtx/models.ts';
import type { DskImage, DskSector } from '@/media/floppy/disk-image.ts';
import { expectDamagedRefused, expectExactResume, observe } from '../machines/native-state-harness.ts';

/**
 * 0000 DI; LD SP,0; I=C0h; IM 2; vectors C010h→0100h (ch 0), C012h→0140h (ch 1)
 *      VDP R1=E0h (display, IE), R7=F4h; CTC vector 10h, ch 0 counter/int TC 1,
 *      ch 1 timer/int TC 40h; C=0; EI
 * 003D loop: INC (8000h); OUT (1) VDP data; OUT (32h)/(33h) 80-col char/attr;
 *      OUT (31h) E1h; OUT (30h) B (write strobe); toggle the RAM page (port 0)
 * 0100 ch 0: read VDP status; INC (C100h); if the FDC is busy read 37 data
 *      bytes, else motor on and READ SECTOR 1
 * 0140 ch 1: (C101h) += 3, OUT (6) it and strobe the PSG with IN (3)
 */
function syntheticRom(): Uint8Array {
  const rom = new Uint8Array(0x2000);
  rom.set([
    0xF3, 0x31, 0x00, 0x00, 0x3E, 0xC0, 0xED, 0x47, 0xED, 0x5E,
    0x21, 0x00, 0x01, 0x22, 0x10, 0xC0, 0x21, 0x40, 0x01, 0x22, 0x12, 0xC0,
    0x3E, 0xE0, 0xD3, 0x02, 0x3E, 0x81, 0xD3, 0x02, 0x3E, 0xF4, 0xD3, 0x02, 0x3E, 0x87, 0xD3, 0x02,
    0x3E, 0x10, 0xD3, 0x08, 0x3E, 0xC5, 0xD3, 0x08, 0x3E, 0x01, 0xD3, 0x08,
    0x3E, 0x85, 0xD3, 0x09, 0x3E, 0x40, 0xD3, 0x09,
    0x0E, 0x00, 0xFB,
    // 003D
    0x3A, 0x00, 0x80, 0x3C, 0x32, 0x00, 0x80, 0xD3, 0x01, 0xD3, 0x32, 0xD3, 0x33,
    0x3E, 0xE1, 0xD3, 0x31, 0x04, 0x78, 0xD3, 0x30,
    0x79, 0xEE, 0x01, 0x4F, 0xD3, 0x00, 0x18, 0xE3,
  ], 0);
  rom.set([
    0xF5, 0xC5, 0xDB, 0x02, 0x3A, 0x00, 0xC1, 0x3C, 0x32, 0x00, 0xC1,
    0xDB, 0x10, 0xE6, 0x01, 0x20, 0x0E,
    0x3E, 0x0C, 0xD3, 0x14, 0x3E, 0x01, 0xD3, 0x12, 0x3E, 0x80, 0xD3, 0x10, 0x18, 0x0A,
    0x06, 0x25, 0xDB, 0x13, 0x32, 0x02, 0xC1, 0x10, 0xF9, 0x00,
    0xC1, 0xF1, 0xFB, 0xED, 0x4D,
  ], 0x100);
  rom.set([
    0xF5, 0x3A, 0x01, 0xC1, 0xC6, 0x03, 0x32, 0x01, 0xC1, 0xD3, 0x06, 0xDB, 0x03,
    0xF1, 0xFB, 0xED, 0x4D,
  ], 0x140);
  return rom;
}

/** One single-sided 40-track disk of sixteen 256-byte sectors, filled from `seed`. */
function disk(seed: number): DskImage {
  const tracks: DskImage['tracks'] = [];
  for (let c = 0; c < 40; c++) {
    const sectors: DskSector[] = [];
    const sectorMap = new Map<number, number>();
    for (let r = 1; r <= 16; r++) {
      const data = new Uint8Array(256);
      for (let i = 0; i < data.length; i++) data[i] = (seed + c * 31 + r * 7 + i) & 0xFF;
      sectorMap.set(r, sectors.length);
      sectors.push({ c, h: 0, r, n: 1, st1: 0, st2: 0, data });
    }
    tracks.push([{ sectors, sectorMap, gap3: 0x1B, filler: 0xE5 }]);
  }
  return { format: 'extended', numTracks: 40, numSides: 1, tracks, diskFormat: 'test', protection: '' };
}

interface Options { model?: MtxModel; col80?: boolean; ram512k?: boolean; floppy?: boolean; disk?: number }

function machine(o: Options = {}): MtxMachine {
  const m = new MtxMachine(o.model ?? 'mtx512', null);
  m.start = async () => {};
  const settings: Record<string, unknown> = {
    'mtx-80-column': o.col80 ?? false,
    'mtx-512k-ram': o.ram512k ?? false,
    'mtx-floppy': o.floppy ?? true,
  };
  m.prepare({ get: <T>(key: string, fallback: T): T => (key in settings ? settings[key] as T : fallback) });
  m.loadROM(syntheticRom());
  m.reset();
  if (o.disk !== undefined) m.services.disks.insert('a', disk(o.disk), `disk${o.disk}.mfloppy`);
  return m;
}

describe('MTX .mtxstate', () => {
  it('is offered for saving and loading', () => {
    const m = machine();
    try {
      expect(m.services.snapshots.formats()).toEqual([{ ext: '.mtxstate', canSave: true }]);
      expect(m.services.media.accepts()).toContainEqual({ ext: '.mtxstate', target: 'snapshot' });
      expect(m.descriptor.ui.saveMenu).toContain('snapshot-mtxstate');
    } finally {
      m.destroy();
    }
  });

  it('resumes exactly with a disk being read across frames', async () => {
    await expectExactResume({
      make: () => machine({ disk: 1 }),
      ext: '.mtxstate',
      before: 31,
      after: 17,
      scramble: m => {
        m.services.disks.insert('a', disk(99), 'other.mfloppy');
        for (let a = 0xC000; a < 0x10000; a++) m.memory.writeByte(a, a * 13);
        m.cpu.pc = 0x0777;
      },
    });
  });

  it('resumes exactly on the 80-column card with the 512 KiB expansion (RS128)', async () => {
    await expectExactResume({
      make: () => machine({ model: 'rs128', col80: true, ram512k: true, disk: 5 }),
      ext: '.mtxstate',
      before: 23,
      after: 13,
    });
  });

  it('resumes exactly on an MTX500 without the FDX', async () => {
    await expectExactResume({
      make: () => machine({ model: 'mtx500', floppy: false }),
      ext: '.mtxstate',
      before: 9,
      after: 7,
    });
  });

  it('carries the disk, its writes and its name, and the ROM pack', async () => {
    const src = machine({ disk: 3 });
    const dst = machine();
    try {
      const pack = new Uint8Array(0x4000).fill(0x5A);
      src.memory.insertRomPack(pack);
      src.services.roms.restoreRomPackName('game.rom');
      for (let f = 0; f < 4; f++) src.tick();
      src.fdc.getDiskImage(0)!.tracks[2][0]!.sectors[4].data[9] = 0x77;
      const file = await src.services.snapshots.save('.mtxstate');

      const mounted = await dst.services.media.mount(file, 'x.mtxstate');
      expect(mounted.ok, mounted.message).toBe(true);
      expect(mounted.mediaChanged).toBe(true);
      const image = dst.fdc.getDiskImage(0)!;
      expect(image).not.toBe(src.fdc.getDiskImage(0));
      expect(image.tracks[2][0]!.sectors[4].data[9]).toBe(0x77);
      expect(image.tracks[39][0]!.sectors[15].data[255]).toBe((3 + 39 * 31 + 16 * 7 + 255) & 0xFF);
      expect(dst.services.disks.drives[0].mediaName).toBe('disk3.mfloppy');
      expect(dst.services.roms.cartridge.name).toBe('game.rom');
      expect(dst.memory.romPackSizeBytes).toBe(0x4000);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('refuses a damaged file and leaves the machine alone', async () => {
    await expectDamagedRefused(() => machine({ disk: 2 }), '.mtxstate');
  });

  it('refuses a state from differently fitted hardware, changing nothing', async () => {
    const cases: [Options, Options, RegExp][] = [
      [{ ram512k: true }, {}, /with the 512 KiB RAM expansion; fit it/],
      [{ col80: true }, {}, /with the 80-column card; fit it/],
      [{}, { floppy: false }, /with the FDX floppy subsystem; fit it/],
    ];
    for (const [from, to, why] of cases) {
      const src = machine(from);
      const dst = machine({ ...to, disk: 4 });
      try {
        for (let f = 0; f < 3; f++) src.tick();
        for (let f = 0; f < 5; f++) dst.tick();
        const before = observe(dst);
        const diskBefore = dst.fdc.getDiskImage(0)?.tracks[7][0]!.sectors[3].data.slice();
        const nameBefore = dst.services.disks.drives[0]?.mediaName;
        const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.mtxstate'), 'x.mtxstate');
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(why);
        expect(observe(dst)).toEqual(before);
        expect(dst.fdc.getDiskImage(0)?.tracks[7][0]!.sectors[3].data).toEqual(diskBefore);
        expect(dst.services.disks.drives[0]?.mediaName).toBe(nameBefore);
      } finally {
        src.destroy();
        dst.destroy();
      }
    }
  });

  it('asks for the model a state was saved on', async () => {
    const src = machine({ model: 'mtx500' });
    const dst = machine({ model: 'mtx512' });
    try {
      src.tick();
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.mtxstate'), 'x.mtxstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/MTX500/);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });
});
