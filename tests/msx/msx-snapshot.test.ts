/**
 * MSX snapshots: zx84's native `.msxstate` — exact resume, refusal of damaged
 * files and of a configuration the machine does not have, the slot-1
 * cartridge and its mega-ROM banks, and the disk interface with a sector
 * transfer caught half-way.
 *
 * The exact-resume checks run on a small synthetic BIOS that keeps the VDP
 * (with its frame interrupt in IM 1), the PSG, the PPI keyboard scan and RAM
 * all moving, and on the real HX-10 BIOS when it is to hand (MSX_BIOS, or
 * mcp/.cache/hx-10_basic-bios1.rom).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';
import type { MsxModel } from '@/machines/msx/models.ts';
import { parseMsxRaw } from '@/media/floppy/msx-disk.ts';
import { expectDamagedRefused, expectExactResume, observe } from '../machines/native-state-harness.ts';

const BIOS = process.env.MSX_BIOS ?? join(import.meta.dirname, '../../mcp/.cache/hx-10_basic-bios1.rom');

const STATUS = 0x7FF8, SECTOR = 0x7FFA, DATA = 0x7FFB, DRIVE = 0x7FFD;

/**
 * 0000 DI; LD A,slots; OUT (A8h),A; LD SP,F000h; IM 1
 * 000A OTIR the VDP register table at 0050h (display on, IE, Graphics I); EI
 * 0014 loop: INC B; OUT (98h),B; PSG reg 8 = B & 0Fh; IN A,(A9h); INC (C000h); JR loop
 * 0038 IM 1 handler: IN A,(99h) (acknowledge the VDP), INC (C001h), EI, RETI
 */
function syntheticBios(slots: number): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom.set([
    0xF3, 0x3E, slots, 0xD3, 0xA8, 0x31, 0x00, 0xF0, 0xED, 0x56,
    0x21, 0x50, 0x00, 0x06, 0x10, 0x0E, 0x99, 0xED, 0xB3, 0xFB,
    0x04, 0x78, 0xD3, 0x98, 0x3E, 0x08, 0xD3, 0xA0, 0x78, 0xE6, 0x0F, 0xD3, 0xA1,
    0xDB, 0xA9, 0x21, 0x00, 0xC0, 0x34, 0x18, 0xEB,
  ], 0);
  rom.set([0xF5, 0xDB, 0x99, 0x3A, 0x01, 0xC0, 0x3C, 0x32, 0x01, 0xC0, 0xF1, 0xFB, 0xED, 0x4D], 0x38);
  rom.set([0x00, 0x80, 0xE0, 0x81, 0x06, 0x82, 0x80, 0x83, 0x00, 0x84, 0x36, 0x85, 0x07, 0x86, 0xF4, 0x87], 0x50);
  return rom;
}

/** Page 2/3 slots for the RAM: slot 2 on the HX-10; the HB-55's RAM sits in
 *  slot 0 page 3, so everything stays on slot 0 there. */
const SLOTS: Record<MsxModel, number> = { 'hx-10': 0xA0, 'hb-55': 0x00, 'hb-55p': 0x00 };

/** A Disk BASIC ROM stand-in: the card only needs a ROM to appear in slot 3. */
function diskRom(): Uint8Array {
  const rom = new Uint8Array(0x4000).fill(0xFF);
  rom[0] = 0x41; rom[1] = 0x42;
  return rom;
}

/** A 720K disk whose sectors hold bytes derived from their position. */
function patternDisk() {
  const raw = new Uint8Array(1440 * 512);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 13 + (i >> 9)) & 0xFF;
  raw[512] = 0xF9;
  return parseMsxRaw(raw);
}

interface Options { model?: MsxModel; rom?: Uint8Array; disk?: boolean; drives?: number }

function machine(o: Options = {}): MsxMachine {
  const model = o.model ?? 'hx-10';
  const m = new MsxMachine(model);
  m.start = async () => {};
  m.loadROM(o.rom ?? syntheticBios(SLOTS[model]));
  if (o.disk) {
    m.loadDiskRom(diskRom());
    m.prepare({
      get: <T>(key: string, fallback: T): T => {
        if (key === 'msx-floppy') return true as T;
        if (key === 'drive-count:msx') return (o.drives ?? 2) as T;
        return fallback;
      },
    });
  }
  m.reset();
  return m;
}

/** A 128KB ASCII8 mega-ROM: every 8KB block filled with its own number. */
function megaRom(): Uint8Array {
  const rom = new Uint8Array(0x20000);
  for (let b = 0; b < 16; b++) rom.fill(0x10 + b, b * 0x2000, (b + 1) * 0x2000);
  rom[0] = 0x41; rom[1] = 0x42;
  return rom;
}

describe('MSX .msxstate', () => {
  it('is offered for saving and loading', () => {
    const m = machine();
    try {
      expect(m.services.snapshots.formats()).toEqual([{ ext: '.msxstate', canSave: true }]);
      expect(m.services.media.accepts().map(t => t.ext)).toContain('.msxstate');
      expect(m.descriptor.ui.saveMenu).toContain('snapshot-msxstate');
    } finally {
      m.destroy();
    }
  });

  for (const model of ['hx-10', 'hb-55'] as const) {
    it(`resumes exactly on the ${model} (synthetic BIOS)`, async () => {
      await expectExactResume({
        make: () => machine({ model }),
        ext: '.msxstate',
        before: 29,
        after: 17,
        scramble: m => {
          for (let a = 0xC000; a < 0xF000; a++) m.memory.writeByte(a, a * 5);
          m.vdp.writeControl(0x00); m.vdp.writeControl(0x87);   // backdrop 0
          m.cpu.pc = 0x0014;
        },
      });
    });
  }

  it('resumes exactly with the disk interface and a disk in A:', async () => {
    await expectExactResume({
      make: () => {
        const m = machine({ disk: true });
        m.services.disks.insert('a', patternDisk(), 'a.dsk');
        return m;
      },
      ext: '.msxstate',
      before: 9,
      after: 11,
    });
  });

  it.skipIf(!existsSync(BIOS))('resumes exactly on the real HX-10 BIOS at the BASIC prompt', async () => {
    // By frame 400 the BIOS has drawn its logo and MSX BASIC prints Ok.
    const bios = new Uint8Array(readFileSync(BIOS));
    await expectExactResume({ make: () => machine({ rom: bios }), ext: '.msxstate', before: 400, after: 60 });
  });

  it('refuses a damaged file and leaves the machine alone', async () => {
    await expectDamagedRefused(() => machine(), '.msxstate');
  });

  it('refuses a state from a machine with the disk interface, changing nothing', async () => {
    const src = machine({ disk: true });
    const dst = machine();
    try {
      for (let f = 0; f < 3; f++) src.tick();
      for (let f = 0; f < 5; f++) dst.tick();
      const before = observe(dst);
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.msxstate'), 'x.msxstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/disk interface fitted/);
      expect(observe(dst)).toEqual(before);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('refuses a state saved with another drive count, changing nothing', async () => {
    const src = machine({ disk: true, drives: 1 });
    const dst = machine({ disk: true, drives: 2 });
    try {
      for (let f = 0; f < 3; f++) src.tick();
      const before = observe(dst);
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.msxstate'), 'x.msxstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/one drive.*2 drives/);
      expect(observe(dst)).toEqual(before);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('asks the host for the model the state was saved on', async () => {
    const src = machine({ model: 'hb-55' });
    const dst = machine();
    try {
      const asked: string[] = [];
      dst.attachHost({
        setStatus: () => {}, persistMedia: () => {},
        requestModel: async model => { asked.push(model); return true; },
      });
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.msxstate'), 'x.msxstate');
      expect(result).toMatchObject({ ok: true, needsReplay: true });
      expect(asked).toEqual(['hb-55']);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('carries the cartridge and its mega-ROM banks, without rebooting', async () => {
    const src = machine();
    const dst = machine();
    try {
      for (let f = 0; f < 4; f++) src.tick();
      src.insertCartridge(megaRom(), 'mega.rom');
      expect(src.memory.cartridgeMapper).toBe('ascii8');
      // Slot 1 in pages 1 and 2, then bank 5, 9, 14 and 3 into 4000/6000/8000/A000.
      src.memory.setPrimarySlots(0x14);
      src.memory.writeByte(0x6000, 5);
      src.memory.writeByte(0x6800, 9);
      src.memory.writeByte(0x7000, 14);
      src.memory.writeByte(0x7800, 3);
      const pc = src.cpu.pc;
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.msxstate'), 'x.msxstate');
      expect(result.ok, result.message).toBe(true);
      expect(dst.cartridgeName).toBe('mega.rom');
      expect(dst.memory.cartridgeMapper).toBe('ascii8');
      expect([0x4000, 0x6000, 0x8000, 0xA000].map(a => dst.memory.readByte(a))).toEqual([0x15, 0x19, 0x1E, 0x13]);
      expect(dst.cpu.pc).toBe(pc);
      // And it is still a working mapper.
      dst.memory.writeByte(0x6000, 7);
      expect(dst.memory.readByte(0x4000)).toBe(0x17);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('carries the disks and a READ SECTOR caught half-way', async () => {
    const src = machine({ disk: true });
    const dst = machine({ disk: true });
    try {
      src.services.disks.insert('a', patternDisk(), 'a.dsk');
      src.diskIf.write(DRIVE, 0x80);        // drive A:, motor on
      src.diskIf.write(SECTOR, 3);
      src.diskIf.write(STATUS, 0x80);       // READ SECTOR
      const head = Array.from({ length: 100 }, () => src.diskIf.read(DATA));
      expect(head[0]).toBe(patternDisk().tracks[0][0]!.sectors[2].data[0]);
      const file = await src.services.snapshots.save('.msxstate');

      const result = await dst.services.snapshots.apply(file, 'x.msxstate');
      expect(result.ok, result.message).toBe(true);
      expect(dst.services.disks.drives[0]).toMatchObject({ loaded: true, mediaName: 'a.dsk' });
      const rest = (m: MsxMachine) => Array.from({ length: 412 }, () => m.diskIf.read(DATA));
      expect(rest(dst)).toEqual(rest(src));
      expect(dst.diskIf.read(STATUS) & 0x01).toBe(0);   // command over
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('a WRITE SECTOR caught half-way lands in the restored disk', async () => {
    const src = machine({ disk: true });
    const dst = machine({ disk: true });
    try {
      src.services.disks.insert('a', patternDisk(), 'a.dsk');
      src.diskIf.write(DRIVE, 0x80);
      src.diskIf.write(SECTOR, 2);
      src.diskIf.write(STATUS, 0xA0);       // WRITE SECTOR
      for (let i = 0; i < 200; i++) src.diskIf.write(DATA, 0xA5);
      const file = await src.services.snapshots.save('.msxstate');
      const result = await dst.services.snapshots.apply(file, 'x.msxstate');
      expect(result.ok, result.message).toBe(true);
      for (let i = 200; i < 512; i++) dst.diskIf.write(DATA, i & 0xFF);
      const data = dst.fdc.getDiskImage(0)!.tracks[0][0]!.sectors[1].data;
      expect(data[0]).toBe(0xA5);
      expect(data[199]).toBe(0xA5);
      expect(data[200]).toBe(200);
      expect(data[511]).toBe(511 & 0xFF);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });
});
