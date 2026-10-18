/**
 * Enterprise drive count: how many of the EXDOS card's four drives are fitted.
 *
 * WD1770 datasheet: RESTORE ends with the seek-error bit (status bit 4) set and
 * TR00 (bit 2) clear when no drive on the select line ever asserts TR00.
 */

import { describe, it, expect } from 'vitest';
import { EnterpriseMachine } from '@/machines/enterprise/enterprise-machine.ts';
import type { SettingsView } from '@/machines/machine.ts';
import { blankFatImage, serializeFatImage } from '@/media/floppy/fat-image.ts';

const ST_BUSY = 0x01;
const ST_TRACK0 = 0x04;
const ST_SEEKERR = 0x10;

const view = (values: Record<string, unknown> = {}): SettingsView => ({
  get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; },
});

function machine(count?: number): EnterpriseMachine {
  const m = new EnterpriseMachine('ep128', null);
  m.prepare(view(count === undefined ? {} : { 'drive-count:enterprise': count }));
  return m;
}

function typeI(m: EnterpriseMachine, unit: number, cmd: number): number {
  const fdc = m.exdos!.fdc;
  fdc.selectDrive(unit);
  fdc.writeCommand(cmd);
  let s = fdc.readStatus();
  for (let i = 0; i < 16 && (s & ST_BUSY); i++) s = fdc.readStatus();
  return s;
}

describe('Enterprise drive count', () => {
  it('fits all four drives when no count was chosen', () => {
    const m = machine();
    expect(m.driveCount).toBe(4);
    expect(m.services.disks.drives.map(d => d.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(m.descriptor.ui.builtinDrives).toBe(4);
  });

  it('lists only the first two drives when two are fitted', () => {
    expect(machine(2).services.disks.drives.map(d => d.label)).toEqual(['A:', 'B:']);
  });

  it('still lists no drives without the EXDOS card', () => {
    const m = new EnterpriseMachine('ep128', null);
    m.prepare(view({ 'enterprise-exdos': false, 'drive-count:enterprise': 2 }));
    expect(m.services.disks.drives).toEqual([]);
  });

  it('ends RESTORE on drives C: and D: in a seek error with TR00 clear', () => {
    const m = machine(2);
    for (const unit of [2, 3]) {
      const s = typeI(m, unit, 0x00);
      expect(s & ST_TRACK0).toBe(0);
      expect(s & ST_SEEKERR).toBe(ST_SEEKERR);
    }
  });

  it('homes the fitted drives cleanly', () => {
    const m = machine(2);
    for (const unit of [0, 1]) {
      const s = typeI(m, unit, 0x00);
      expect(s & ST_TRACK0).toBe(ST_TRACK0);
      expect(s & ST_SEEKERR).toBe(0);
    }
  });

  it('seeks on a fitted drive and fails a seek on an absent one', () => {
    const m = machine(2);
    m.exdos!.fdc.writeData(10);
    expect(typeI(m, 1, 0x10) & ST_SEEKERR).toBe(0);
    m.exdos!.fdc.writeData(10);
    expect(typeI(m, 2, 0x10) & ST_SEEKERR).toBe(ST_SEEKERR);
  });

  it('applies the count to a card fitted after construction', () => {
    const m = machine(1);
    m.setExdosFitted(false);
    m.setExdosFitted(true);
    expect(typeI(m, 1, 0x00) & ST_SEEKERR).toBe(ST_SEEKERR);
  });

  it('refuses a disk for an absent drive, by id and by unit', async () => {
    const m = machine(2);
    const data = serializeFatImage(blankFatImage());
    expect(() => m.services.disks.insert('c', blankFatImage(), 'c.img')).toThrow('that drive is not fitted');
    for (const target of ['c', 'd', 'unit:2', 'unit:3', 'unit:9']) {
      const res = await m.services.media.mount(data, 'c.img', target);
      expect(res.ok).toBe(false);
      expect((res as { message: string }).message).toContain('not fitted');
    }
    expect(m.exdos!.fdc.getDiskImage(2)).toBeNull();
    expect(m.exdos!.fdc.getDiskImage(3)).toBeNull();
  });

  it('mounts into a fitted drive and reads its boot sector', async () => {
    const m = machine(2);
    const res = await m.services.media.mount(serializeFatImage(blankFatImage()), 'b.img', 'b');
    expect(res.ok).toBe(true);
    expect(m.services.disks.drives[1].loaded).toBe(true);
    const fdc = m.exdos!.fdc;
    fdc.selectDrive(1);
    fdc.setSide(0);
    fdc.writeSectorReg(1);
    fdc.writeCommand(0x80);
    // A FAT boot sector opens with the x86 short jump EB xx 90.
    expect(fdc.readData()).toBe(0xEB);
    fdc.readData();
    expect(fdc.readData()).toBe(0x90);
  });

  it('fits drive D: when four are fitted', async () => {
    const m = machine(4);
    const res = await m.services.media.mount(serializeFatImage(blankFatImage()), 'd.img', 'd');
    expect(res.ok).toBe(true);
    expect(m.exdos!.fdc.getDiskImage(3)).not.toBeNull();
  });
});
