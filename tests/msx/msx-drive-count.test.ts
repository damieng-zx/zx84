/**
 * MSX drive count: how many of the floppy interface's two drives are fitted.
 *
 * WD2793 datasheet: RESTORE ends with the seek-error bit (status bit 4) set and
 * TR00 (bit 2) clear when the selected drive never asserts TR00; the 2793's
 * READY input comes from the drive, so an absent one reads NOT READY (bit 7).
 */

import { describe, it, expect } from 'vitest';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';
import type { SettingsView } from '@/machines/machine.ts';
import { blankMsxDisk, parseMsxFloppy, serializeMsxRaw } from '@/media/floppy/msx-disk.ts';

const ST_BUSY = 0x01;
const ST_TRACK0 = 0x04;
const ST_SEEKERR = 0x10;
const ST_NOT_READY = 0x80;

const view = (values: Record<string, unknown> = {}): SettingsView => ({
  get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; },
});

/** A machine with the disk interface fitted (stub ROM) and `count` drives. */
function machine(count?: number, extra: Record<string, unknown> = {}): MsxMachine {
  const m = new MsxMachine('hx-10', null);
  m.loadDiskRom(new Uint8Array(0x4000).fill(0xFF));
  m.prepare(view({ 'msx-floppy': true, ...(count === undefined ? {} : { 'drive-count:msx': count }), ...extra }));
  return m;
}

/** A 720K disk whose first data sector (logical 1) is filled with `fill`. */
function rawDisk(fill: number): Uint8Array {
  const raw = serializeMsxRaw(blankMsxDisk(0xF9));
  raw.fill(fill, 512, 1024);
  return raw;
}

function typeI(m: MsxMachine, unit: number, cmd: number): number {
  m.fdc.selectDrive(unit);
  m.fdc.writeCommand(cmd);
  let s = m.fdc.readStatus();
  for (let i = 0; i < 16 && (s & ST_BUSY); i++) s = m.fdc.readStatus();
  return s;
}

describe('MSX drive count', () => {
  it('fits both drives when no count was chosen', () => {
    const m = machine();
    expect(m.driveCount).toBe(2);
    expect(m.services.disks.drives.map(d => d.id)).toEqual(['a', 'b']);
    expect(m.descriptor.ui.builtinDrives).toBe(2);
  });

  it('lists only A: when one drive is fitted', () => {
    expect(machine(1).services.disks.drives.map(d => d.label)).toEqual(['A:']);
  });

  it('still lists no drives at all without the interface', () => {
    const m = new MsxMachine('hx-10', null);
    m.prepare(view({ 'msx-floppy': false, 'drive-count:msx': 1 }));
    expect(m.services.disks.drives).toEqual([]);
  });

  it('ends RESTORE on the absent drive B: in a seek error, TR00 clear, NOT READY', () => {
    const m = machine(1);
    const s = typeI(m, 1, 0x00);
    expect(s & ST_TRACK0).toBe(0);
    expect(s & ST_SEEKERR).toBe(ST_SEEKERR);
    expect(s & ST_NOT_READY).toBe(ST_NOT_READY);
  });

  it('keeps the absent drive NOT READY even with an image left in its slot', () => {
    const m = machine(1);
    m.fdc.insertDisk(parseMsxFloppy(rawDisk(0)), 1);
    expect(typeI(m, 1, 0x00) & ST_NOT_READY).toBe(ST_NOT_READY);
  });

  it('homes the fitted A: cleanly and homes B: too when two are fitted', () => {
    const one = machine(1);
    const a = typeI(one, 0, 0x00);
    expect(a & ST_TRACK0).toBe(ST_TRACK0);
    expect(a & ST_SEEKERR).toBe(0);
    const two = machine(2);
    const b = typeI(two, 1, 0x00);
    expect(b & ST_TRACK0).toBe(ST_TRACK0);
    expect(b & ST_SEEKERR).toBe(0);
  });

  it('refuses a disk for the absent drive B:', async () => {
    const m = machine(1);
    expect(() => m.services.disks.insert('b', parseMsxFloppy(rawDisk(1)), 'b.dsk')).toThrow('that drive is not fitted');
    for (const target of ['b', 'unit:1', 'unit:5']) {
      const res = await m.services.media.mount(rawDisk(1), 'b.dsk', target);
      expect(res.ok).toBe(false);
      expect((res as { message: string }).message).toContain('not fitted');
    }
    expect(m.fdc.getDiskImage(1)).toBeNull();
  });

  it('mounts into A: and reads its first data sector', async () => {
    const m = machine(1);
    const res = await m.services.media.mount(rawDisk(0xA5), 'a.dsk');
    expect(res.ok).toBe(true);
    m.fdc.selectDrive(0);
    m.fdc.setSide(0);
    m.fdc.writeSectorReg(2);      // logical sector 1 = cylinder 0, head 0, record 2
    m.fdc.writeCommand(0x80);
    for (let i = 0; i < 512; i++) expect(m.fdc.readData()).toBe(0xA5);
  });

  it('mounts into B: when two drives are fitted', async () => {
    const m = machine(2);
    const res = await m.services.media.mount(rawDisk(1), 'b.dsk', 'b');
    expect(res.ok).toBe(true);
    expect(res.ok && res.target).toBe('b');
  });
});
