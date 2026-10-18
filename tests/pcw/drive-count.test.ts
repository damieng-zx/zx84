/**
 * PCW drive count: the model's own drives (one on the 8256/9512, two on the
 * 8512), which the user may reduce but never exceed.
 *
 * uPD765A datasheet: a select line with no drive cannot report track 0, so
 * RECALIBRATE ends with an equipment check, and Sense Drive Status reports the
 * unit not ready.
 */

import { describe, it, expect } from 'vitest';
import { PcwMachine } from '@/machines/pcw/pcw-machine.ts';
import { pcwEntry } from '@/machines/pcw/descriptor.ts';
import type { SettingsView } from '@/machines/machine.ts';
import { createBlankDisk, DISK_FORMATS, serializeDSK } from '@/media/floppy/dsk.ts';
import type { PcwModel } from '@/machines/pcw/models.ts';

const view = (values: Record<string, unknown>): SettingsView => ({
  get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; },
});

function machine(model: PcwModel, count?: number): PcwMachine {
  const m = new PcwMachine(model, null);
  m.prepare(view(count === undefined ? {} : { 'drive-count:pcw': count }));
  return m;
}

const dskBytes = () => serializeDSK(createBlankDisk(DISK_FORMATS[0]));

function recalibrate(m: PcwMachine, unit: number): number {
  m.fdc.writeData(0x07);
  m.fdc.writeData(unit);
  m.fdc.writeData(0x08);
  const st0 = m.fdc.readData();
  m.fdc.readData();
  return st0;
}

describe('PCW drive count', () => {
  it('declares each model\'s own drive count as the maximum', () => {
    expect(pcwEntry.descriptor('pcw8256').ui.builtinDrives).toBe(1);
    expect(pcwEntry.descriptor('pcw9512').ui.builtinDrives).toBe(1);
    expect(pcwEntry.descriptor('pcw8512').ui.builtinDrives).toBe(2);
  });

  it('fits both of the 8512\'s drives by default', () => {
    const m = machine('pcw8512');
    expect(m.driveCount).toBe(2);
    expect(m.services.disks!.drives.map(d => d.id)).toEqual(['a', 'b']);
    expect(m.fdc.connected).toEqual([true, true]);
    expect(recalibrate(m, 1) & 0xF8).toBe(0x20);
  });

  it('lets an 8512 be fitted with just one drive', async () => {
    const m = machine('pcw8512', 1);
    expect(m.driveCount).toBe(1);
    expect(m.services.disks!.drives.map(d => d.id)).toEqual(['a']);
    expect(m.fdc.connected).toEqual([true, false]);
    const st0 = recalibrate(m, 1);
    expect(st0 & 0xC0).toBe(0x40);
    expect(st0 & 0x10).toBe(0x10);
    expect(recalibrate(m, 0) & 0xF8).toBe(0x20);

    for (const target of ['b', 'unit:1'] as const) {
      expect((await m.services.media.mount(dskBytes(), 'x.dsk', target)).ok).toBe(false);
    }
    expect(m.fdc.getDiskImage(1)).toBeNull();
    expect(m.fdc.getDiskImage(0)).toBeNull();     // and nothing was redirected to A:
    expect(() => m.services.disks!.insert('b', createBlankDisk(DISK_FORMATS[0]), 'x.dsk'))
      .toThrow('that drive is not fitted');
    expect((await m.services.media.mount(dskBytes(), 'x.dsk', 'a')).ok).toBe(true);
  });

  it('never fits more drives than the model shipped with', () => {
    const m = machine('pcw8256', 2);
    expect(m.driveCount).toBe(1);
    expect(m.services.disks!.drives.map(d => d.id)).toEqual(['a']);
    expect(m.fdc.connected).toEqual([true, false]);
  });
});
