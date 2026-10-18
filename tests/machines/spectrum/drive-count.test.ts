/**
 * Spectrum drive count: how many of the +3's built-in drives, or of the +D /
 * Beta Disk pair, are fitted.
 *
 * Expectations come from the datasheets, not the implementation:
 *  - uPD765A: a select line with no drive cannot report track 0, so RECALIBRATE
 *    and SEEK end with an equipment check (ST0 IC=01 + EC), and Sense Drive
 *    Status (ST3) reports the unit not ready.
 *  - WD1793: RESTORE steps out until TR00 asserts; with no drive on the select
 *    line it never does, so the command ends with the seek-error bit (status
 *    bit 4) set and TR00 (bit 2) clear.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import type { SettingsView } from '@/machines/machine.ts';
import { blankTrdDisk, serializeTrd } from '@/media/floppy/trd-image.ts';
import { blankMgtDisk, serializeMgt } from '@/media/floppy/mgt-image.ts';
import { serializeDSK, createBlankDisk, DISK_FORMATS } from '@/media/floppy/dsk.ts';

const view = (values: Record<string, unknown>): SettingsView => ({
  get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; },
});

function machine(model: 'zx48k' | 'zx128kplus3', settings: Record<string, unknown>): Spectrum {
  const s = new Spectrum(model, null);
  s.start = async () => {};
  s.prepare(view(settings));
  return s;
}

const dskBytes = () => serializeDSK(blankMgtDisk(40, 1));
const trdBytes = () => serializeTrd(blankTrdDisk(80, 2));
const mgtBytes = () => serializeMgt(blankMgtDisk(80, 2), 'mgt');

const ST0_EQUIP_CHECK = 0x10;
const ST0_ABNORMAL = 0x40;
const ST3_READY = 0x20;

function sense(s: Spectrum, unit: number): number {
  s.fdc.writeData(0x04);
  s.fdc.writeData(unit);
  return s.fdc.readData();
}

function recalibrate(s: Spectrum, unit: number): number {
  s.fdc.writeData(0x07);
  s.fdc.writeData(unit);
  s.fdc.writeData(0x08);
  const st0 = s.fdc.readData();
  s.fdc.readData();
  return st0;
}

describe('+3 built-in drives', () => {
  it('fits both drives when no count was chosen', () => {
    const s = machine('zx128kplus3', {});
    expect(s.driveCount).toBe(2);
    expect(s.services.disks!.drives.map(d => d.id)).toEqual(['a', 'b']);
    expect(s.fdc.connected).toEqual([true, true]);
  });

  it('declares two as the most a Spectrum can take', () => {
    expect(new Spectrum('zx128kplus3', null).descriptor.ui.builtinDrives).toBe(2);
  });

  it('with one drive lists only A: and leaves select line 1 unwired', () => {
    const s = machine('zx128kplus3', { 'drive-count:spectrum': 1 });
    expect(s.driveCount).toBe(1);
    expect(s.services.disks!.drives.map(d => d.id)).toEqual(['a']);
    expect(s.fdc.connected).toEqual([true, false]);
  });

  it('with one drive, unit 1 fails RECALIBRATE with an equipment check and reads not-ready', () => {
    const s = machine('zx128kplus3', { 'drive-count:spectrum': 1 });
    s.fdc.forceReady[1] = true;       // even the drive-B-ready mod cannot conjure a drive
    const st0 = recalibrate(s, 1);
    expect(st0 & 0xC0).toBe(ST0_ABNORMAL);
    expect(st0 & ST0_EQUIP_CHECK).toBe(ST0_EQUIP_CHECK);
    expect(sense(s, 1) & ST3_READY).toBe(0);
    // Drive A still works.
    expect(recalibrate(s, 0) & 0xF8).toBe(0x20);
  });

  it('with two drives, unit 1 recalibrates normally', () => {
    const s = machine('zx128kplus3', { 'drive-count:spectrum': 2 });
    expect(recalibrate(s, 1) & 0xF8).toBe(0x20);   // Seek End, no fault
  });

  it('refuses to mount into drive B when only one is fitted', async () => {
    const s = machine('zx128kplus3', { 'drive-count:spectrum': 1 });
    for (const target of ['b', 'unit:1'] as const) {
      const r = await s.services.media.mount(dskBytes(), 'x.dsk', target);
      expect(r.ok).toBe(false);
    }
    expect(s.fdc.getDiskImage(1)).toBeNull();
    expect(() => s.services.disks!.insert('b', createBlankDisk(DISK_FORMATS[0]), 'x.dsk'))
      .toThrow('that drive is not fitted');
    const a = await s.services.media.mount(dskBytes(), 'x.dsk', 'a');
    expect(a.ok).toBe(true);
    expect(s.fdc.getDiskImage(0)).not.toBeNull();
  });

  it('mounts into drive B when two are fitted', async () => {
    const s = machine('zx128kplus3', {});
    const r = await s.services.media.mount(dskBytes(), 'x.dsk', 'unit:1');
    expect(r.ok).toBe(true);
    expect(s.fdc.getDiskImage(1)).not.toBeNull();
  });
});

const CACHE = resolve(__dirname, '../../../mcp/.cache');
const PLUS3_ROMS = ['plus3-41-0.rom', 'plus3-41-1.rom', 'plus3-41-2.rom', 'plus3-41-3.rom'];
describe.skipIf(!PLUS3_ROMS.every(n => existsSync(resolve(CACHE, n))))('+3 firmware with one drive', () => {
  it('boots to the +3 menu with drive B unwired', () => {
    const s = machine('zx128kplus3', { 'drive-count:spectrum': 1 });
    const rom = new Uint8Array(PLUS3_ROMS.length * 0x4000);
    PLUS3_ROMS.forEach((n, i) => rom.set(readFileSync(resolve(CACHE, n)), i * 0x4000));
    s.loadROM(rom);
    s.reset();
    s.fdc.insertDisk(createBlankDisk(DISK_FORMATS[0]), 0);
    for (let f = 0; f < 200; f++) s.tick();
    expect(s.ocrScreenForMcp()).toContain('Loader');
    expect(s.fdc.connected).toEqual([true, false]);
  });
});

describe('+D drives (C: / D:)', () => {
  it('lists both drives by default and only C: with one fitted', () => {
    const two = machine('zx48k', { plusd: true });
    expect(two.mgtPlusD.enabled).toBe(true);
    expect(two.services.disks!.drives.map(d => d.id)).toEqual(['plusd:0', 'plusd:1']);

    const one = machine('zx48k', { plusd: true, 'drive-count:spectrum': 1 });
    expect(one.services.disks!.drives.map(d => d.id)).toEqual(['plusd:0']);
  });

  it('ends RESTORE on the unwired drive in a seek error, leaves the fitted one alone', () => {
    const s = machine('zx48k', { plusd: true, 'drive-count:spectrum': 1 });
    const wd = s.mgtPlusD.fdc;
    expect(wd.connected.slice(0, 2)).toEqual([true, false]);
    wd.selectDrive(1);
    wd.writeCommand(0x00);                         // RESTORE
    expect(wd.readStatus() & 0x10).toBe(0x10);     // seek error
    expect(wd.readStatus() & 0x04).toBe(0);        // no TR00
    wd.selectDrive(0);
    wd.writeCommand(0x00);
    expect(wd.readStatus() & 0x10).toBe(0);
    expect(wd.readStatus() & 0x04).toBe(0x04);
  });

  it('refuses a mount into D: when one drive is fitted, without throwing', async () => {
    const s = machine('zx48k', { plusd: true, 'drive-count:spectrum': 1 });
    const bad = await s.services.media.mount(mgtBytes(), 'x.mgt', 'plusd:1');
    expect(bad.ok).toBe(false);
    const viaUnit = await s.services.media.mount(mgtBytes(), 'x.mgt', 'unit:1');
    expect(viaUnit.ok).toBe(false);
    expect(() => s.services.disks!.insert('plusd:1', blankMgtDisk(80, 2), 'x.mgt'))
      .toThrow('that drive is not fitted');
    const good = await s.services.media.mount(mgtBytes(), 'x.mgt', 'plusd:0');
    expect(good.ok).toBe(true);
  });
});

describe('Beta Disk drives (A: / B:)', () => {
  it('lists both drives by default and only A: with one fitted', () => {
    const two = machine('zx48k', { betadisk: true });
    expect(two.betaDisk.enabled).toBe(true);
    expect(two.services.disks!.drives.map(d => d.id)).toEqual(['beta:0', 'beta:1']);

    const one = machine('zx48k', { betadisk: true, 'drive-count:spectrum': 1 });
    expect(one.services.disks!.drives.map(d => d.id)).toEqual(['beta:0']);
  });

  it('ends RESTORE on the unwired drive in a seek error', () => {
    const s = machine('zx48k', { betadisk: true, 'drive-count:spectrum': 1 });
    const wd = s.betaDisk.fdc;
    wd.selectDrive(1);
    wd.writeCommand(0x00);
    expect(wd.readStatus() & 0x10).toBe(0x10);
    expect(wd.readStatus() & 0x04).toBe(0);
  });

  it('keeps both drives wired at the default count', () => {
    const s = machine('zx48k', { betadisk: true });
    const wd = s.betaDisk.fdc;
    wd.selectDrive(1);
    wd.writeCommand(0x00);
    expect(wd.readStatus() & 0x10).toBe(0);
    expect(wd.readStatus() & 0x04).toBe(0x04);
  });

  it('refuses a mount into B: when one drive is fitted', async () => {
    const s = machine('zx48k', { betadisk: true, 'drive-count:spectrum': 1 });
    const bad = await s.services.media.mount(trdBytes(), 'x.trd', 'beta:1');
    expect(bad.ok).toBe(false);
    const good = await s.services.media.mount(trdBytes(), 'x.trd', 'beta:0');
    expect(good.ok).toBe(true);
  });
});
