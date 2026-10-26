/**
 * Einstein drive count: how many of the WD1772's two drives are fitted.
 *
 * WD1772 datasheet: RESTORE steps the head out until the drive's TR00 input
 * asserts. With no drive on the select line it never does, so the command ends
 * with the seek-error bit (status bit 4) set and TR00 (bit 2) clear.
 */

import { describe, it, expect } from 'vitest';
import { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import type { SettingsView } from '@/machines/machine.ts';
import type { DskImage, DskSector, DskTrack } from '@/media/floppy/disk-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';

const ST_BUSY = 0x01;
const ST_TRACK0 = 0x04;
const ST_SEEKERR = 0x10;

const view = (values: Record<string, unknown> = {}): SettingsView => ({
  get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; },
});

function machine(count?: number): EinsteinMachine {
  const m = new EinsteinMachine('einstein-tc01', null);
  m.prepare(view(count === undefined ? {} : { 'drive-count:einstein': count }));
  return m;
}

function image(fill: number): DskImage {
  const data = new Uint8Array(512).fill(fill);
  const sectors: DskSector[] = [{ c: 0, h: 0, r: 1, n: 2, st1: 0, st2: 0, data }];
  const track: DskTrack = { sectors, sectorMap: new Map([[1, 0]]), gap3: 82, filler: 0xE5 };
  return { format: 'standard', numTracks: 1, numSides: 1, tracks: [[track]], diskFormat: 'MGT +D', protection: '' };
}

/** Run a Type I command on `unit` and return the status once BUSY has cleared. */
function typeI(m: EinsteinMachine, unit: number, cmd: number): number {
  m.fdc.selectDrive(unit);
  m.fdc.writeCommand(cmd);
  let s = m.fdc.readStatus();
  for (let i = 0; i < 16 && (s & ST_BUSY); i++) s = m.fdc.readStatus();
  return s;
}

describe('Einstein drive count', () => {
  it('fits both drives when no count was chosen', () => {
    const m = machine();
    expect(m.driveCount).toBe(2);
    expect(m.services.disks.drives.map(d => d.id)).toEqual(['a', 'b']);
    expect(m.descriptor.ui.builtinDrives).toBe(2);
  });

  it('lists only drive 0 when one drive is fitted', () => {
    const m = machine(1);
    expect(m.services.disks.drives.map(d => d.id)).toEqual(['a']);
  });

  it('ends RESTORE and SEEK on the absent drive in a seek error with TR00 clear', () => {
    const m = machine(1);
    const restore = typeI(m, 1, 0x00);
    expect(restore & ST_TRACK0).toBe(0);
    expect(restore & ST_SEEKERR).toBe(ST_SEEKERR);
    m.fdc.writeData(5);
    expect(typeI(m, 1, 0x10) & ST_SEEKERR).toBe(ST_SEEKERR);
  });

  it('still homes the fitted drive 0 cleanly', () => {
    const m = machine(1);
    const s = typeI(m, 0, 0x00);
    expect(s & ST_TRACK0).toBe(ST_TRACK0);
    expect(s & ST_SEEKERR).toBe(0);
  });

  it('homes both drives when two are fitted', () => {
    const m = machine(2);
    const s = typeI(m, 1, 0x00);
    expect(s & ST_TRACK0).toBe(ST_TRACK0);
    expect(s & ST_SEEKERR).toBe(0);
  });

  it('refuses a disk for the absent drive, by id and by unit', async () => {
    const m = machine(1);
    const data = serializeDSK(image(0x5A));
    expect(() => m.services.disks.insert('b', image(0x5A), 'b.dsk')).toThrow('that drive is not fitted');
    for (const target of ['b', 'unit:1', 'unit:7']) {
      const res = await m.services.media.mount(data, 'b.dsk', target);
      expect(res.ok).toBe(false);
      expect((res as { message: string }).message).toContain('not fitted');
    }
    expect(m.fdc.getDiskImage(1)).toBeNull();
  });

  it('mounts into and reads a sector from the fitted drive', async () => {
    const m = machine(1);
    const res = await m.services.media.mount(serializeDSK(image(0xAB)), 'a.dsk');
    expect(res.ok).toBe(true);
    expect(m.services.disks.drives[0].loaded).toBe(true);
    m.fdc.selectDrive(0);
    m.fdc.setSide(0);
    m.fdc.writeSectorReg(1);
    m.fdc.writeCommand(0x80);
    for (let i = 0; i < 512; i++) expect(m.fdc.readData()).toBe(0xAB);
  });

  it('mounts into drive 1 when two drives are fitted', async () => {
    const m = machine(2);
    const res = await m.services.media.mount(serializeDSK(image(0xCD)), 'b.dsk', 'b');
    expect(res.ok).toBe(true);
    expect(m.fdc.getDiskImage(1)).not.toBeNull();
  });
});
