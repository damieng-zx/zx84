/**
 * Camputers Lynx snapshots: zx84's native `.lynxstate` — exact resume on each
 * board, the drives and an FD1793 transfer carried across a save, damaged
 * files and a mismatched disk interface refused without touching the machine.
 *
 * The Lynx ROMs are not to hand, so the machines run a small synthetic ROM
 * that programs the 6845, switches the bank port so its stores land in user
 * RAM and a video plane at once, drives the DAC, and flips the alternate
 * green plane from the VSYNC interrupt — RAM, banking, video and the IM 1
 * interrupt all keep moving.
 */

import { describe, it, expect } from 'vitest';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';
import type { LynxModel } from '@/machines/lynx/models.ts';
import { expectDamagedRefused, expectExactResume, observe } from '../machines/native-state-harness.ts';

const CRTC_TABLE = 0x0050;
/** 39 rows of 8 lines, VSYNC from row 35: the PAL frame (as lynx-beam). */
const CRTC = [4, 38, 9, 7, 5, 0, 6, 32, 7, 35, 3, 0x20, 1, 32];

function program(): Uint8Array {
  const code = [
    0xF3,                         // 0000 DI
    0x31, 0x00, 0xC0,             // 0001 LD SP,C000h
    0xED, 0x56,                   // 0004 IM 1
    0x21, CRTC_TABLE, 0x00,       // 0006 LD HL,CRTC_TABLE
    0x06, CRTC.length / 2,        // 0009 LD B,pairs
    0x7E, 0xD3, 0x86,             // 000B LD A,(HL); OUT (86h),A
    0x23, 0x7E, 0xD3, 0x87,       // 000E INC HL; LD A,(HL); OUT (87h),A
    0x23, 0x10, 0xF6,             // 0012 INC HL; DJNZ 000Bh
    0x3E, 0x06, 0xD3, 0x7F,       // 0015 48K/96K: stores to user RAM and all planes
    0x3E, 0x40, 0xD3, 0x82,       // 0019 128K: stores to user RAM and video
    0x21, 0x00, 0x40,             // 001D LD HL,4000h
    0xFB,                         // 0020 EI
    0x7E, 0xC6, 0x03, 0x77,       // 0021 LD A,(HL); ADD A,3; LD (HL),A
    0xD3, 0x84,                   // 0025 OUT (84h),A   the DAC
    0x23, 0x7C, 0xFE, 0x60,       // 0027 INC HL; LD A,H; CP 60h
    0x20, 0xF4,                   // 002B JR NZ,0021h
    0x21, 0x00, 0x40,             // 002D LD HL,4000h
    0x76,                         // 0030 HALT
    0x18, 0xEE,                   // 0031 JR 0021h
  ];
  const isr = [
    0xF5,                         // 0038 PUSH AF
    0x3A, 0x00, 0x90,             //      LD A,(9000h)
    0xEE, 0x10,                   //      XOR 10h
    0x32, 0x00, 0x90,             //      LD (9000h),A
    0xD3, 0x80,                   //      OUT (80h),A   alternate green on/off
    0xF1, 0xFB, 0xC9,             //      POP AF; EI; RET
  ];
  // Three system images and a (blank) DOS ROM, as the 96K/128K load them.
  const rom = new Uint8Array(0x8000).fill(0xFF);
  rom.set(code, 0);
  rom.set(isr, 0x0038);
  rom.set(CRTC, CRTC_TABLE);
  return rom;
}

function machine(model: LynxModel, fdc = true, drives = 4): LynxMachine {
  const m = new LynxMachine(model, null);
  m.start = async () => {};
  m.applySettings({
    get: <T>(key: string, fallback: T): T => {
      if (key === 'lynx-fdc') return fdc as T;
      if (key.includes('drive')) return drives as T;
      return fallback;
    },
  });
  m.loadROM(program());
  m.reset();
  return m;
}

/** A blank 800K `.ldf` (80 tracks, 2 sides, 10 × 512-byte sectors) whose
 *  bytes carry their own offset, so any sector read says where it came from. */
function ldf(): Uint8Array {
  const out = new Uint8Array(80 * 2 * 10 * 512);
  for (let i = 0; i < out.length; i++) out[i] = (i * 13 + (i >> 9)) & 0xFF;
  return out;
}

describe('Lynx .lynxstate', () => {
  it('is offered for saving and loading', () => {
    const m = machine('lynx96');
    try {
      expect(m.services.snapshots.formats()).toEqual([{ ext: '.lynxstate', canSave: true }]);
      expect(m.services.media.accepts().some(t => t.ext === '.lynxstate' && t.target === 'snapshot')).toBe(true);
      expect(m.descriptor.ui.saveMenu).toContain('snapshot-lynxstate');
    } finally {
      m.destroy();
    }
  });

  for (const model of ['lynx48', 'lynx96', 'lynx128'] as const) {
    it(`resumes exactly on the ${model}`, async () => {
      await expectExactResume({
        make: () => machine(model),
        ext: '.lynxstate',
        before: 29,
        after: 17,
        scramble: m => {
          m.memory.userRam.fill(0x5A);
          m.memory.videoRam.fill(0xA5);
          m.crtc.selectRegister(1); m.crtc.writeRegister(20);
          m.memory.writeBankPort(0x31);
          m.setPort80(0x14);
          m.cpu.pc = 0x1234;
        },
      });
    });
  }

  it('refuses a damaged file and leaves the machine alone', async () => {
    await expectDamagedRefused(() => machine('lynx96'), '.lynxstate');
  });

  it('refuses a state saved with the disk interface removed, changing nothing', async () => {
    const src = machine('lynx96', false);
    const dst = machine('lynx96', true);
    try {
      for (let f = 0; f < 4; f++) src.tick();
      for (let f = 0; f < 6; f++) dst.tick();
      const before = observe(dst);
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.lynxstate'), 'x.lynxstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/disk interface removed/);
      expect(observe(dst)).toEqual(before);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('asks for the model a state was saved on', async () => {
    const src = machine('lynx128');
    const dst = machine('lynx96');
    try {
      src.tick();
      const asked: string[] = [];
      dst.attachHost({
        setStatus: () => {},
        requestModel: async model => { asked.push(model); return true; },
        persistMedia: () => {},
      });
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.lynxstate'), 'x.lynxstate');
      expect(result).toMatchObject({ ok: true, needsReplay: true });
      expect(asked).toEqual(['lynx128']);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });
});

describe('Lynx .lynxstate drives', () => {
  it('carries the disks, their names and tabs in a file, and a read in flight', async () => {
    const src = machine('lynx96');
    const dst = machine('lynx96');
    try {
      expect((await src.services.media.mount(ldf(), 'work.ldf', 'b')).ok).toBe(true);
      src.services.disks.setWriteProtect('b', true);
      for (let f = 0; f < 3; f++) src.tick();
      // Drive B, side 0, head on track 0: READ SECTOR 3, 100 bytes taken.
      src.fdc.selectDrive(1);
      src.fdc.writeSectorReg(3);
      src.fdc.writeCommand(0x80);
      for (let i = 0; i < 100; i++) src.fdc.readData();

      const file = await src.services.snapshots.save('.lynxstate');
      const result = await dst.services.media.mount(file, 'x.lynxstate');
      expect(result.ok, result.message).toBe(true);
      expect(result.mediaChanged).toBe(true);

      const drive = dst.services.disks.drives[1];
      expect(drive).toMatchObject({ loaded: true, mediaName: 'work.ldf', writeProtected: true });
      expect(dst.services.disks.drives[0].loaded).toBe(false);
      // The rest of the sector, byte for byte, then the same status.
      const rest = (m: LynxMachine) => Array.from({ length: 412 }, () => m.fdc.readData());
      expect(rest(dst)).toEqual(rest(src));
      expect(dst.fdc.readStatus()).toBe(src.fdc.readStatus());
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('finishes a sector write begun before the save into the restored disk', async () => {
    const src = machine('lynx128');
    const dst = machine('lynx128');
    try {
      await src.services.media.mount(ldf(), 'work.ldf', 'a');
      src.fdc.selectDrive(0);
      src.fdc.writeSectorReg(5);
      src.fdc.writeCommand(0xA0);   // WRITE SECTOR
      for (let i = 0; i < 200; i++) src.fdc.writeData(0x11);

      const file = await src.services.snapshots.save('.lynxstate');
      expect((await dst.services.snapshots.apply(file, 'x.lynxstate')).ok).toBe(true);
      for (let i = 200; i < 512; i++) dst.fdc.writeData(0x22);

      const sector = dst.services.disks.image('a')!.tracks[0][0]!.sectors.find(s => s.r === 5)!;
      expect(Array.from(sector.data.subarray(0, 200)).every(b => b === 0x11)).toBe(true);
      expect(Array.from(sector.data.subarray(200)).every(b => b === 0x22)).toBe(true);
      expect(dst.fdc.isDirty(0)).toBe(true);
      // The original's disk is untouched by the copy's write.
      const orig = src.services.disks.image('a')!.tracks[0][0]!.sectors.find(s => s.r === 5)!;
      expect(orig.data[300]).not.toBe(0x22);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('leaves the mounted disks alone on a refresh restore, which carries none', async () => {
    const src = machine('lynx96');
    const dst = machine('lynx96');
    try {
      await src.services.media.mount(ldf(), 'src.ldf', 'a');
      await dst.services.media.mount(ldf(), 'dst.ldf', 'b');
      src.tick();
      expect(await dst.services.snapshots.restoreSync(src.services.snapshots.saveSync())).toBe(true);
      expect(dst.services.disks.drives[0].loaded).toBe(false);
      expect(dst.services.disks.drives[1].mediaName).toBe('dst.ldf');
    } finally {
      src.destroy();
      dst.destroy();
    }
  });
});
