/**
 * MTX drive count: how many of the FDX's two drives (B: and C:) are fitted.
 *
 * WD179x datasheet: RESTORE ends with the seek-error bit (status bit 4) set and
 * TR00 (bit 2) clear when no drive on the select line ever asserts TR00.
 */

import { describe, it, expect } from 'vitest';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';
import type { SettingsView } from '@/machines/machine.ts';

const ST_BUSY = 0x01;
const ST_TRACK0 = 0x04;
const ST_SEEKERR = 0x10;

const view = (values: Record<string, unknown> = {}): SettingsView => ({
  get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; },
});

function machine(count?: number): MtxMachine {
  const m = new MtxMachine('mtx512', null);
  m.prepare(view(count === undefined ? {} : { 'drive-count:mtx': count }));
  m.reset();
  return m;
}

/** A Type 07 style double-sided 80-track image: 0xA0000 bytes, sector 0 of
 *  every track marked so a read proves which sector came back. */
function mfloppy(fill: number): Uint8Array {
  const data = new Uint8Array(0xA0000);
  data.fill(fill, 0, 512);
  return data;
}

/** RESTORE through the FDX's own ports: select the drive at 0x14, command at 0x10. */
function restoreViaPorts(m: MtxMachine, unit: number): number {
  m.cpu.portOut(0x14, 0x04 | unit);          // motor on, drive select in bit 0
  m.cpu.portOut(0x10, 0x00);
  let s = m.cpu.portIn(0x10);
  for (let i = 0; i < 16 && (s & ST_BUSY); i++) s = m.cpu.portIn(0x10);
  return s;
}

describe('MTX drive count', () => {
  it('fits both drives when no count was chosen', () => {
    const m = machine();
    expect(m.driveCount).toBe(2);
    expect(m.services.disks.drives.map(d => d.label)).toEqual(['Drive B:', 'Drive C:']);
    expect(m.descriptor.ui.builtinDrives).toBe(2);
  });

  it('lists only Drive B: when one drive is fitted', () => {
    expect(machine(1).services.disks.drives.map(d => d.label)).toEqual(['Drive B:']);
  });

  it('still lists no drives without the FDX', () => {
    const m = new MtxMachine('mtx512', null);
    m.prepare(view({ 'mtx-floppy': false, 'drive-count:mtx': 1 }));
    m.reset();
    expect(m.services.disks.drives).toEqual([]);
  });

  it('ends RESTORE on the absent Drive C: in a seek error with TR00 clear', () => {
    const s = restoreViaPorts(machine(1), 1);
    expect(s & ST_TRACK0).toBe(0);
    expect(s & ST_SEEKERR).toBe(ST_SEEKERR);
  });

  it('homes Drive B: cleanly, and Drive C: when both are fitted', () => {
    const a = restoreViaPorts(machine(1), 0);
    expect(a & ST_TRACK0).toBe(ST_TRACK0);
    expect(a & ST_SEEKERR).toBe(0);
    const c = restoreViaPorts(machine(2), 1);
    expect(c & ST_TRACK0).toBe(ST_TRACK0);
    expect(c & ST_SEEKERR).toBe(0);
  });

  it('refuses a disk for the absent Drive C:', async () => {
    const m = machine(1);
    expect(() => m.services.disks.insert('b', null as never, 'c.mfloppy')).toThrow('that drive is not fitted');
    for (const target of ['b', 'unit:1', 'unit:3']) {
      const res = await m.services.media.mount(mfloppy(1), 'c.mfloppy', target);
      expect(res.ok).toBe(false);
      expect((res as { message: string }).message).toContain('not fitted');
    }
    expect(m.fdc.getDiskImage(1)).toBeNull();
  });

  it('mounts into Drive B: and reads sector 1 of track 0', async () => {
    const m = machine(1);
    const res = await m.services.media.mount(mfloppy(0xC3), 'b.mfloppy');
    expect(res.ok).toBe(true);
    m.fdc.selectDrive(0);
    m.fdc.setSide(0);
    m.fdc.writeSectorReg(1);
    m.fdc.writeCommand(0x80);
    expect(m.fdc.readData()).toBe(0xC3);
  });

  it('mounts into Drive C: when two drives are fitted', async () => {
    const m = machine(2);
    const res = await m.services.media.mount(mfloppy(1), 'c.mfloppy', 'b');
    expect(res.ok).toBe(true);
    expect(m.fdc.getDiskImage(1)).not.toBeNull();
  });
});
