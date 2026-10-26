/**
 * Drive count on the Acorn machines (BBC Micro 8271 / 1770 DFS, Electron Plus 3).
 *
 * The user picks how many of the two built-in floppy drives are fitted. A
 * missing drive must look missing to the machine's own disc software, so the
 * tests drive the controllers' register interfaces the way the OS does:
 *
 *  - Intel 8271 datasheet, READ DRIVE STATUS: the result byte carries the
 *    Ready flags (bit 2 = drive 0, bit 6 = drive 1) and TRK0 (bit 1). Acorn DFS
 *    reads drive 1's status to decide whether a second drive exists, so with
 *    no drive on select line 1 its Ready and TRK0 bits must read 0.
 *  - WD1770 datasheet, Type I status: TR00 (bit 2) is the drive's track-0
 *    sensor and the Seek Error bit (bit 4) is set when the head cannot find the
 *    track. With nothing on the select line there is no TR00 pulse, so RESTORE
 *    ends with TR00 clear and Seek Error set.
 */

import { describe, it, expect } from 'vitest';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { ElectronMachine } from '@/machines/electron/electron-machine.ts';
import type { SettingsView } from '@/machines/machine.ts';
import { blankSsd, SSD_TRACK_BYTES } from '@/media/floppy/ssd.ts';
import { parseAdfs } from '@/media/floppy/adfs.ts';

const TR00 = 0x04;
const SEEK_ERROR = 0x10;
const BUSY = 0x01;

function view(settings: Record<string, unknown>): SettingsView {
  return { get: <T,>(k: string, f: T): T => (k in settings ? (settings[k] as T) : f) };
}

const ssdBytes = (): Uint8Array => new Uint8Array(SSD_TRACK_BYTES * 80);

/** Run READ DRIVE STATUS for `drive` through the 8271's register window. */
function driveStatus8271(m: BbcMachine, drive: 0 | 1): number {
  m.acorn8271.write(0xFE80, drive === 0 ? 0x6C : 0xAC);
  return m.acorn8271.read(0xFE81);
}

describe('BBC drive count: 8271 (Acorn DFS)', () => {
  it('with one drive fitted, drive 1 reports neither ready nor at track 0; drive 0 does', () => {
    const m = new BbcMachine('bbc-b', null);
    m.prepare(view({ 'bbc-disk-system': 'acorn', 'drive-count:bbc': 1 }));
    const d0 = driveStatus8271(m, 0);
    expect(d0 & 0x80).toBe(0x80);        // bit 7 always set
    expect(d0 & 0x04).toBe(0x04);        // drive 0 ready
    expect(d0 & 0x02).toBe(0x02);        // drive 0 at track 0
    const d1 = driveStatus8271(m, 1);
    expect(d1 & 0x80).toBe(0x80);
    expect(d1 & 0x40).toBe(0);           // drive 1 not ready
    expect(d1 & 0x02).toBe(0);           // no track-0 sensor
    m.destroy();
  });

  it('with two drives (default) drive 1 is ready and at track 0', () => {
    const m = new BbcMachine('bbc-b', null);
    m.prepare(view({ 'bbc-disk-system': 'acorn' }));
    expect(m.driveCount).toBe(2);
    const d1 = driveStatus8271(m, 1);
    expect(d1 & 0x40).toBe(0x40);
    expect(d1 & 0x02).toBe(0x02);
    m.destroy();
  });

  it('clamps nonsense counts to the 1..2 the model can take', () => {
    const m = new BbcMachine('bbc-b', null);
    m.prepare(view({ 'drive-count:bbc': 7 }));
    expect(m.driveCount).toBe(2);
    m.prepare(view({ 'drive-count:bbc': 0 }));
    expect(m.driveCount).toBe(1);
    m.destroy();
  });
});

/** RESTORE on `drive` of the BBC 1770 interface, via the memory bus. */
function restore1770(m: BbcMachine, drive: 0 | 1): number {
  m.memory.writeByte(0xFE80, 0x20 | (drive === 1 ? 0x02 : 0)); // reset released, drive select
  m.memory.writeByte(0xFE84, 0x00);                             // RESTORE
  m.fdc1770.tick(0x20000);
  return m.memory.readByte(0xFE84);
}

describe('BBC drive count: 1770 DFS', () => {
  it('with one drive, RESTORE of unit 1 ends in seek error with TR00 clear; unit 0 is fine', () => {
    const m = new BbcMachine('bbc-b', null);
    m.prepare(view({ 'bbc-disk-system': '1770', 'drive-count:bbc': 1 }));
    const s0 = restore1770(m, 0);
    expect(s0 & BUSY).toBe(0);
    expect(s0 & TR00).toBe(TR00);
    expect(s0 & SEEK_ERROR).toBe(0);
    const s1 = restore1770(m, 1);
    expect(s1 & BUSY).toBe(0);
    expect(s1 & TR00).toBe(0);
    expect(s1 & SEEK_ERROR).toBe(SEEK_ERROR);
    m.destroy();
  });

  it('with two drives, RESTORE of unit 1 succeeds', () => {
    const m = new BbcMachine('bbc-b', null);
    m.prepare(view({ 'bbc-disk-system': '1770', 'drive-count:bbc': 2 }));
    const s1 = restore1770(m, 1);
    expect(s1 & TR00).toBe(TR00);
    expect(s1 & SEEK_ERROR).toBe(0);
    m.destroy();
  });

  it('the count survives switching the disc interface', () => {
    const m = new BbcMachine('bbc-b', null);
    m.prepare(view({ 'bbc-disk-system': '1770', 'drive-count:bbc': 1 }));
    m.setDiskSystem('acorn');
    const d1 = driveStatus8271(m, 1);
    expect(d1 & 0x40).toBe(0);
    m.setDiskSystem('1770');
    expect(restore1770(m, 1) & SEEK_ERROR).toBe(SEEK_ERROR);
    m.destroy();
  });
});

describe('BBC drive count: services', () => {
  it('lists only the fitted drives and refuses a mount into the missing one', async () => {
    const m = new BbcMachine('bbc-b', null);
    m.prepare(view({ 'drive-count:bbc': 1 }));
    expect(m.services.disks.drives.map(d => d.id)).toEqual(['a']);
    expect(() => m.services.disks.insert('b', blankSsd(80, false), 'x.ssd'))
      .toThrow('that drive is not fitted');
    for (const target of ['b', 'unit:1'] as const) {
      const res = await m.services.media.mount(ssdBytes(), 'x.ssd', target);
      expect(res.ok).toBe(false);
    }
    expect(m.disc!.getDiskImage(1)).toBeNull();
    // Drive 0 still takes a disc, by name or unit hint.
    expect(await m.services.media.mount(ssdBytes(), 'x.ssd', 'unit:0')).toMatchObject({ ok: true, target: 'a' });
    expect(m.disc!.getDiskImage(0)).not.toBeNull();
    m.destroy();
  });

  it('with two drives both mount, including by unit hint', async () => {
    const m = new BbcMachine('bbc-b', null);
    m.prepare(view({}));
    expect(m.services.disks.drives.map(d => d.id)).toEqual(['a', 'b']);
    expect(await m.services.media.mount(ssdBytes(), 'x.ssd', 'b')).toMatchObject({ ok: true, target: 'b' });
    expect(await m.services.media.mount(ssdBytes(), 'y.ssd', 'unit:1')).toMatchObject({ ok: true, target: 'b' });
    expect(m.disc!.getDiskImage(1)).not.toBeNull();
    m.destroy();
  });
});

// --- Electron Plus 3 --------------------------------------------------------

function electron(settings: Record<string, unknown>): ElectronMachine {
  const m = new ElectronMachine('electron', null);
  m.prepare(view({ 'electron-plus3': true, ...settings }));
  return m;
}

/** RESTORE on `drive` of the Plus 3 (latch at &FCC0, WD1770 at &FCC4). */
function restorePlus3(m: ElectronMachine, drive: 0 | 1): number {
  m.plus3.write(0xFCC0, 0x20 | (drive === 1 ? 0x02 : 0x01)); // reset released, drive select
  m.plus3.write(0xFCC4, 0x00);                               // RESTORE
  m.plus3.tick(0x20000);
  return m.plus3.read(0xFCC4)!;
}

describe('Electron drive count: Plus 3 (WD1770)', () => {
  it('with one drive, RESTORE of unit 1 ends in seek error with TR00 clear; unit 0 is fine', () => {
    const m = electron({ 'drive-count:electron': 1 });
    expect(m.driveCount).toBe(1);
    const s0 = restorePlus3(m, 0);
    expect(s0 & BUSY).toBe(0);
    expect(s0 & TR00).toBe(TR00);
    expect(s0 & SEEK_ERROR).toBe(0);
    const s1 = restorePlus3(m, 1);
    expect(s1 & BUSY).toBe(0);
    expect(s1 & TR00).toBe(0);
    expect(s1 & SEEK_ERROR).toBe(SEEK_ERROR);
    m.destroy();
  });

  it('with two drives, RESTORE of unit 1 succeeds', () => {
    const m = electron({});
    expect(m.driveCount).toBe(2);
    const s1 = restorePlus3(m, 1);
    expect(s1 & TR00).toBe(TR00);
    expect(s1 & SEEK_ERROR).toBe(0);
    m.destroy();
  });

  it('lists only the fitted drives and refuses a mount into the missing one', async () => {
    const m = electron({ 'drive-count:electron': 1 });
    const adfs = new Uint8Array(655360);
    expect(m.services.disks.drives.map(d => d.id)).toEqual(['a']);
    expect(() => m.services.disks.insert('b', parseAdfs(new Uint8Array(163840)), 'x.adf'))
      .toThrow('that drive is not fitted');
    for (const target of ['b', 'unit:1'] as const) {
      const res = await m.services.media.mount(adfs, 'x.adl', target);
      expect(res.ok).toBe(false);
    }
    expect(m.plus3.getDiskImage(1)).toBeNull();
    expect(await m.services.media.mount(adfs, 'x.adl', 'unit:0')).toMatchObject({ ok: true, target: 'a' });
    m.destroy();
  });

  it('with two drives both mount, including by unit hint', async () => {
    const m = electron({});
    expect(m.services.disks.drives.map(d => d.id)).toEqual(['a', 'b']);
    expect(await m.services.media.mount(new Uint8Array(655360), 'x.adl', 'unit:1'))
      .toMatchObject({ ok: true, target: 'b' });
    expect(m.plus3.getDiskImage(1)).not.toBeNull();
    m.destroy();
  });
});
