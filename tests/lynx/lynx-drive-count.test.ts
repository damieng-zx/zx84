/**
 * Lynx drive count: how many of the FD1793's four drives (A: to D:) are fitted.
 *
 * WD1793 datasheet: RESTORE ends with the seek-error bit (status bit 4) set and
 * TR00 (bit 2) clear when no drive asserts TR00 on the selected line, and the
 * READY input is the drive's, so an absent drive reads NOT READY (bit 7).
 */

import { describe, it, expect } from 'vitest';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';
import type { SettingsView } from '@/machines/machine.ts';
import { parseLdf } from '@/media/floppy/ldf-image.ts';

const ST_BUSY = 0x01;
const ST_TRACK0 = 0x04;
const ST_SEEKERR = 0x10;
const ST_NOT_READY = 0x80;

const view = (values: Record<string, unknown> = {}): SettingsView => ({
  get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; },
});

function machine(count?: number): LynxMachine {
  const m = new LynxMachine('lynx128', null);
  m.applySettings(view(count === undefined ? {} : { 'drive-count:lynx': count }));
  return m;
}

/** An 800K dump (80 tracks, 2 sides, 10 x 512-byte sectors) whose first byte is `first`. */
function ldf(first: number): Uint8Array {
  const out = new Uint8Array(80 * 2 * 10 * 512);
  out[0] = first;
  return out;
}

function typeI(m: LynxMachine, unit: number, cmd: number): number {
  m.fdc.selectDrive(unit);
  m.fdc.writeCommand(cmd);
  let s = m.fdc.readStatus();
  for (let i = 0; i < 16 && (s & ST_BUSY); i++) s = m.fdc.readStatus();
  return s;
}

describe('Lynx drive count', () => {
  it('fits all four drives when no count was chosen', () => {
    const m = machine();
    expect(m.driveCount).toBe(4);
    expect(m.services.disks.drives.map(d => d.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(m.descriptor.ui.builtinDrives).toBe(4);
  });

  it('lists only the first two drives when two are fitted', () => {
    expect(machine(2).services.disks.drives.map(d => d.label)).toEqual(['A:', 'B:']);
  });

  it('lists only A: when one drive is fitted', () => {
    expect(machine(1).services.disks.drives.map(d => d.id)).toEqual(['a']);
  });

  it('ends RESTORE on the absent drives in a seek error, TR00 clear, NOT READY', () => {
    const m = machine(2);
    for (const unit of [2, 3]) {
      const s = typeI(m, unit, 0x00);
      expect(s & ST_TRACK0).toBe(0);
      expect(s & ST_SEEKERR).toBe(ST_SEEKERR);
      expect(s & ST_NOT_READY).toBe(ST_NOT_READY);
    }
  });

  it('keeps an absent drive NOT READY even with an image left in its slot', () => {
    const m = machine(1);
    m.fdc.insertDisk(parseLdf(ldf(1))!, 1);
    expect(typeI(m, 1, 0x00) & ST_NOT_READY).toBe(ST_NOT_READY);
  });

  it('homes the fitted drives cleanly', () => {
    const m = machine(2);
    for (const unit of [0, 1]) {
      const s = typeI(m, unit, 0x00);
      expect(s & ST_TRACK0).toBe(ST_TRACK0);
      expect(s & ST_SEEKERR).toBe(0);
    }
  });

  it('fails a command on the absent drive when it is selected through port 0x58', () => {
    const m = machine(1);
    m.cpu.portOut(0x0058, 1);
    expect(m.fdc.currentDrive).toBe(1);
    m.fdc.writeCommand(0x00);
    expect(m.fdc.readStatus() & ST_SEEKERR).toBe(ST_SEEKERR);
  });

  it('refuses a disk for an absent drive, by id and by unit', async () => {
    const m = machine(2);
    expect(() => m.services.disks.insert('c', parseLdf(ldf(1))!, 'c.ldf')).toThrow('that drive is not fitted');
    for (const target of ['c', 'd', 'unit:2', 'unit:3']) {
      const res = await m.services.media.mount(ldf(1), 'c.ldf', target);
      expect(res.ok).toBe(false);
      expect((res as { message: string }).message).toContain('not fitted');
    }
    expect(m.fdc.getDiskImage(2)).toBeNull();
    expect(m.fdc.getDiskImage(3)).toBeNull();
  });

  it('mounts into the fitted drives and reads a sector', async () => {
    const m = machine(2);
    expect((await m.services.media.mount(ldf(0x77), 'a.ldf')).ok).toBe(true);
    expect((await m.services.media.mount(ldf(0x88), 'b.ldf', 'b')).ok).toBe(true);
    m.fdc.selectDrive(1);
    m.fdc.setSide(0);
    m.fdc.writeSectorReg(1);
    m.fdc.writeCommand(0x80);
    expect(m.fdc.readData()).toBe(0x88);
  });
});
