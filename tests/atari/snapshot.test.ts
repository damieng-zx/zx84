/**
 * zx84's native Atari snapshot (`.a8state`): the container's integrity checks,
 * what the file carries (cartridge, disks, tape), and that a restore is exact.
 *
 * Exactness is the point of a native format, so the determinism tests run two
 * machines from the same instant and compare them frame for frame: one carries
 * on from where it was saved, the other is restored from the file into a
 * machine that had been somewhere else entirely. They must not differ in a
 * byte of state or a pixel. Those cases boot the real firmware (looked up as
 * altirra-boot.test.ts does) and are skipped when it is not to hand.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import {
  ALTIRRA_BASIC_SOURCE, ALTIRRA_OS_SOURCE, ALTIRRA_XL_OS_SOURCE, ATARI_OS_SIZE,
  atariInfo, type AtariModel, type AtariRegion,
} from '@/machines/atari/models.ts';
import {
  decodeAtariState, saveAtariState, saveAtariStateSync,
} from '@/machines/atari/snapshots/atari-state.ts';
import { crc32 } from '@/machines/shared/state-io.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

const DIRS = [process.env.ATARI_ROM_DIR, resolve(__dirname, '../../mcp/.cache')]
  .filter((d): d is string => !!d);

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

/** A synthetic OS that only paints COLBK, for the tests that need no firmware. */
function syntheticOs(): Uint8Array {
  const rom = new Uint8Array(ATARI_OS_SIZE);
  rom.set([0xa9, 0x1e, 0x8d, 0x1a, 0xd0, 0x4c, 0x00, 0xe0], 0x800);
  rom[0x27fc] = 0x00;
  rom[0x27fd] = 0xe0;
  return rom;
}

function plain(model: AtariModel = 'atari800', region: AtariRegion = 'ntsc'): AtariMachine {
  const m = new AtariMachine(model, null, region);
  m.services.roms.installSystemRom(syntheticOs());
  m.reset();
  m.setSpeedMultiplier(0);
  return m;
}

/** A machine on the real AltirraOS and Altirra BASIC, booted to Ready. */
function booted(model: AtariModel, region: AtariRegion = 'pal'): AtariMachine {
  const info = atariInfo(model);
  const os = info.xl ? OS_XL! : OS_800!;
  const m = new AtariMachine(model, null, region);
  if (info.builtinBasic) {
    m.services.roms.installSystemRom(new Uint8Array([...os, ...BASIC!]));
  } else {
    m.services.roms.installSystemRom(os);
    m.services.roms.cartridge.insert(BASIC!, '');
  }
  m.reset();
  m.setSpeedMultiplier(0);
  for (let f = 0; f < 150; f++) m.tick();
  return m;
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

/** Everything observable about a machine at a frame boundary: its state as a
 *  snapshot would record it, and the picture. */
function fingerprint(m: AtariMachine): { state: number; picture: number } {
  return { state: crc32(saveAtariStateSync(m)), picture: crc32(m.pixels) };
}

describe('Atari snapshot container', () => {
  it('records the machine it came from and round-trips through the decoder', async () => {
    const m = plain('atari800xl', 'pal');
    try {
      for (let f = 0; f < 5; f++) m.tick();
      const file = await saveAtariState(m);
      const { info } = await decodeAtariState(file);
      expect(info.model).toBe('atari800xl');
      expect(info.region).toBe('pal');
      expect(info.media).toBe(true);
      const sync = await decodeAtariState(saveAtariStateSync(m));
      expect(sync.info.media).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('refuses a file that is not a snapshot, is truncated, or has been altered', async () => {
    const m = plain();
    try {
      m.tick();
      const sync = saveAtariStateSync(m);
      const file = await saveAtariState(m);
      await expect(decodeAtariState(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]))).rejects.toThrow(/Not a zx84 Atari snapshot/);
      await expect(decodeAtariState(sync.subarray(0, sync.length - 10))).rejects.toThrow(/corrupt or truncated/);
      await expect(decodeAtariState(file.subarray(0, file.length - 10))).rejects.toThrow(/corrupt/);

      const altered = sync.slice();
      altered[altered.length >> 1] ^= 0x40;
      await expect(decodeAtariState(altered)).rejects.toThrow(/corrupt or truncated/);

      const future = sync.slice();
      future[4] = 99;
      await expect(decodeAtariState(future)).rejects.toThrow(/Unsupported Atari snapshot version 99/);
    } finally {
      m.destroy();
    }
  });
});

describe('Atari snapshot service', () => {
  it('offers .a8state for saving and loading', () => {
    const m = plain();
    try {
      expect(m.services.snapshots.formats()).toEqual([{ ext: '.a8state', canSave: true }]);
      expect(m.services.media.accepts().some(t => t.ext === '.a8state')).toBe(true);
      expect(m.descriptor.ui.saveMenu).toContain('snapshot-a8state');
    } finally {
      m.destroy();
    }
  });

  it('restores registers, RAM and the cartridge bank exactly', async () => {
    const src = plain();
    const dst = plain();
    try {
      // A 16K OSS M091 board, switched to a non-default bank.
      const oss = new Uint8Array(0x4000);
      oss[0x1fff] = 0; oss[0x2fff] = 9; oss[0x3fff] = 1;
      oss[0x0000] = 0x11; oss[0x1000] = 0x22; oss[0x2000] = 0x33; oss[0x3000] = 0x44;
      src.services.roms.cartridge.insert(oss, 'oss.rom');
      src.memory.readByte(0xd509); // bank $2000 at $A000
      expect(src.memory.readByte(0xa000)).toBe(0x33);
      src.cpu.a = 0x5a; src.cpu.x = 0x11; src.cpu.y = 0x22; src.cpu.sp = 0xe0;
      src.memory.writeByte(0x1234, 0x99);
      for (let f = 0; f < 3; f++) src.tick();

      const file = await src.services.snapshots.save('.a8state');
      const result = await dst.services.snapshots.apply(file, 'x.a8state');
      expect(result.ok).toBe(true);
      expect(result.message).toContain('Loaded Atari snapshot');

      expect(dst.memory.readByte(0x1234)).toBe(0x99);
      expect(dst.cartridgeName).toBe('oss.rom');
      expect(dst.memory.readByte(0xa000)).toBe(0x33);
      expect(dst.cpu.tStates).toBe(src.cpu.tStates);
      expect(dst.cpu.pc).toBe(src.cpu.pc);
      expect(dst.cpu.x).toBe(0x11);
      // (The picture is the last frame drawn; a restore does not carry it.)
      expect(fingerprint(dst).state).toBe(fingerprint(src).state);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('carries disks (writes included) and the tape, and leaves them alone when the file has none', async () => {
    const src = plain();
    const dst = plain();
    try {
      const xfd = new Uint8Array(92_160);
      for (let i = 0; i < xfd.length; i++) xfd[i] = i & 0xff;
      src.services.disks.insert('a', xfd, 'game.xfd');
      src.services.disks.writeSector(0x31, 5, new Uint8Array(128).fill(0xa5));
      src.services.disks.setWriteProtect('b', true);
      src.services.disks.states[0].percom = new Uint8Array([40, 1, 0, 18, 0, 4, 0, 128, 255, 0, 0, 0]);

      src.cassette.writeRecord(new Uint8Array([0xfc, ...new Uint8Array(128).fill(7)]));
      src.cassette.writeRecord(new Uint8Array([0xfe, ...new Uint8Array(128)]));
      const cas = src.cassette.recorded()!;
      src.cassette.mount(cas, 'tape.cas');
      src.cassette.readRecord();

      const file = await src.services.snapshots.save('.a8state');
      expect((await dst.services.snapshots.apply(file, 'x.a8state')).ok).toBe(true);

      const drive = dst.services.disks.drives[0];
      expect(drive.loaded).toBe(true);
      expect(drive.mediaName).toBe('game.xfd');
      expect([...dst.services.disks.readSector(0x31, 5)!]).toEqual(new Array(128).fill(0xa5));
      expect([...dst.services.disks.readSector(0x31, 6)!]).toEqual([...xfd.subarray(5 * 128, 6 * 128)]);
      expect(dst.services.disks.drives[1].writeProtected).toBe(true);
      expect([...dst.services.disks.states[0].percom!]).toEqual([40, 1, 0, 18, 0, 4, 0, 128, 255, 0, 0, 0]);
      expect(dst.services.disks.states[1].percom).toBeNull();
      expect(dst.cassette.name).toBe('tape.cas');
      expect(dst.cassette.seconds).toBe(src.cassette.seconds);
      expect(dst.cassette.currentFile()).toBe(src.cassette.currentFile());

      // The refresh path leaves media out; loading that over a machine with
      // other media must not eject it.
      const other = plain();
      try {
        other.services.disks.insert('a', xfd, 'other.xfd');
        other.cassette.mount(cas, 'other.cas');
        const sync = saveAtariStateSync(src);
        expect(await other.services.snapshots.restoreSync(sync)).toBe(true);
        expect(other.services.disks.drives[0].mediaName).toBe('other.xfd');
        expect(other.cassette.name).toBe('other.cas');
      } finally {
        other.destroy();
      }
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('refuses a snapshot from the other TV standard and one for another model without a host', async () => {
    const pal = plain('atari800', 'pal');
    const ntsc = plain('atari800', 'ntsc');
    const xl = plain('atari800xl', 'ntsc');
    try {
      const file = await pal.services.snapshots.save('.a8state');
      const region = await ntsc.services.snapshots.apply(file, 'p.a8state');
      expect(region.ok).toBe(false);
      expect(region.message).toMatch(/PAL machine; this one is NTSC/);

      const ntscFile = await ntsc.services.snapshots.save('.a8state');
      const model = await xl.services.snapshots.apply(ntscFile, 'n.a8state');
      expect(model.ok).toBe(false);
      expect(model.message).toMatch(/Atari 800.*switch to it first/);
      expect(await xl.services.snapshots.restoreSync(saveAtariStateSync(ntsc))).toBe(false);
    } finally {
      pal.destroy();
      ntsc.destroy();
      xl.destroy();
    }
  });

  it('asks the host for the snapshot\'s model and reports a replay', async () => {
    const ntsc = plain('atari800', 'ntsc');
    const xl = plain('atari800xl', 'ntsc');
    try {
      const requested: string[] = [];
      xl.attachHost({
        setStatus: () => {},
        requestModel: async (model) => { requested.push(model); return true; },
        persistMedia: () => {},
      });
      const r = await xl.services.snapshots.apply(await ntsc.services.snapshots.save('.a8state'), 'n.a8state');
      expect(requested).toEqual(['atari800']);
      expect(r).toMatchObject({ ok: true, needsReplay: true });
    } finally {
      ntsc.destroy();
      xl.destroy();
    }
  });

  it('warns when the state was saved under a different OS ROM', async () => {
    const src = plain();
    const dst = new AtariMachine('atari800', null, 'ntsc');
    try {
      const other = syntheticOs();
      other[0x100] = 0xff;
      dst.services.roms.installSystemRom(other);
      dst.reset();
      const r = await dst.services.snapshots.apply(await src.services.snapshots.save('.a8state'), 'x.a8state');
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/different OS ROM/);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('serves the hidden BASIC remount as a no-op once a snapshot has put it back', async () => {
    const m = plain();
    try {
      const basic = new Uint8Array(0x2000).fill(0x77);
      m.services.roms.cartridge.insert(basic, '');
      const before = m.cpu.tStates;
      m.services.roms.cartridge.insert(basic, '');
      expect(m.cpu.tStates).toBe(before); // no reset
      expect(m.memory.cart).not.toBeNull();
    } finally {
      m.destroy();
    }
  });
});

describe.each([
  ['atari800', 'ntsc'],
  ['atari800xl', 'pal'],
  ['atari130xe', 'pal'],
] as const)('Atari snapshot determinism on AltirraOS (%s %s)', { timeout: 60_000 }, (model, region) => {
  const os = atariInfo(model).xl ? OS_XL : OS_800;

  it.skipIf(!os || !BASIC)('a restored machine runs identically to the one that was saved', async () => {
    const a = booted(model, region);
    const b = booted(model, region);
    try {
      // Give the program something that changes every frame: the colour
      // registers, the display, POKEY's timers (the OS's), keyboard state.
      type(a, '10 FOR I=0 TO 255:POKE 710,I:POKE 712,255-I:NEXT I:GOTO 10\nRUN\n');
      for (let f = 0; f < 20; f++) a.tick();

      const file = await a.services.snapshots.save('.a8state');
      // Applying a state restarts the machine, which re-inits the audio output
      // (and so the sample being built); do the same to the original.
      a.stop();
      await a.start();

      // The other machine is somewhere else entirely when the state arrives.
      type(b, 'PRINT "NOT THE SAME"\n');
      for (let f = 0; f < 7; f++) b.tick();
      expect(fingerprint(b).state).not.toBe(fingerprint(a).state);

      const r = await b.services.snapshots.apply(file, 'x.a8state');
      expect(r.ok, r.message).toBe(true);
      expect(fingerprint(b).state).toBe(fingerprint(a).state);

      for (let f = 0; f < 60; f++) {
        a.tick();
        b.tick();
        const fa = fingerprint(a);
        const fb = fingerprint(b);
        expect(fb, `frame ${f} after the restore`).toEqual(fa);
      }
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  it.skipIf(!os || !BASIC)('survives the refresh path: sync save, restoreSync on a rebuilt machine', async () => {
    const a = booted(model, region);
    try {
      type(a, 'PRINT 2+2\n');
      for (let f = 0; f < 10; f++) a.tick();
      const blob = a.services.snapshots.saveSync();
      a.stop();
      await a.start();

      // The rebuilt machine is booted from scratch, as lifecycle.ts does.
      const b = booted(model, region);
      try {
        expect(await b.services.snapshots.restoreSync(blob)).toBe(true);
        expect(fingerprint(b).state).toBe(fingerprint(a).state);
        for (let f = 0; f < 30; f++) {
          a.tick();
          b.tick();
        }
        expect(fingerprint(b)).toEqual(fingerprint(a));
      } finally {
        b.destroy();
      }
    } finally {
      a.destroy();
    }
  });
});
