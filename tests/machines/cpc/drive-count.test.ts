/**
 * CPC drive count: how many of the built-in 3" drives are fitted.
 *
 * uPD765A datasheet: a select line with no drive cannot report track 0, so
 * RECALIBRATE and SEEK end with an equipment check (ST0 IC=01 + EC), and Sense
 * Drive Status (ST3) reports the unit not ready.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { cpcEntry } from '@/machines/cpc/descriptor.ts';
import type { SettingsView } from '@/machines/machine.ts';
import { createBlankDisk, DISK_FORMATS, serializeDSK } from '@/media/floppy/dsk.ts';

const view = (values: Record<string, unknown>): SettingsView => ({
  get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; },
});

function machine(count?: number): CpcMachine {
  const m = new CpcMachine('cpc6128', null);
  m.prepare(view(count === undefined ? {} : { 'drive-count:cpc': count }));
  return m;
}

const dataFormat = () => DISK_FORMATS.find(f => f.label === 'CPC Data')!;
const dskBytes = () => serializeDSK(createBlankDisk(dataFormat()));

function recalibrate(m: CpcMachine, unit: number): number {
  m.fdc.writeData(0x07);
  m.fdc.writeData(unit);
  m.fdc.writeData(0x08);
  const st0 = m.fdc.readData();
  m.fdc.readData();
  return st0;
}

function sense(m: CpcMachine, unit: number): number {
  m.fdc.writeData(0x04);
  m.fdc.writeData(unit);
  return m.fdc.readData();
}

describe('CPC drive count', () => {
  it('declares two drives as the maximum for a disk-capable model', () => {
    for (const model of ['cpc664', 'cpc6128'] as const) {
      expect(cpcEntry.descriptor(model).ui.builtinDrives).toBe(2);
    }
  });

  it('fits both drives by default', () => {
    const m = machine();
    expect(m.driveCount).toBe(2);
    expect(m.services.disks!.drives.map(d => d.id)).toEqual(['a', 'b']);
    expect(m.fdc.connected).toEqual([true, true]);
    expect(recalibrate(m, 1) & 0xF8).toBe(0x20);
  });

  it('with one drive lists only A: and unwires select line 1', () => {
    const m = machine(1);
    expect(m.services.disks!.drives.map(d => d.id)).toEqual(['a']);
    expect(m.fdc.connected).toEqual([true, false]);
  });

  it('with one drive, unit 1 fails RECALIBRATE (equipment check) and reads not-ready', () => {
    const m = machine(1);
    m.fdc.forceReady[1] = true;
    const st0 = recalibrate(m, 1);
    expect(st0 & 0xC0).toBe(0x40);
    expect(st0 & 0x10).toBe(0x10);
    expect(sense(m, 1) & 0x20).toBe(0);
    expect(recalibrate(m, 0) & 0xF8).toBe(0x20);
  });

  it('with one drive, refuses a mount to B (by id or unit) and accepts A', async () => {
    const m = machine(1);
    for (const target of ['b', 'unit:1'] as const) {
      expect((await m.services.media.mount(dskBytes(), 'x.dsk', target)).ok).toBe(false);
    }
    expect(m.fdc.getDiskImage(1)).toBeNull();
    expect(() => m.services.disks!.insert('b', createBlankDisk(dataFormat()), 'x.dsk'))
      .toThrow('that drive is not fitted');
    expect((await m.services.media.mount(dskBytes(), 'x.dsk', 'a')).ok).toBe(true);
    expect(m.fdc.getDiskImage(0)).not.toBeNull();
  });

  it('with two drives, mounts into B', async () => {
    const m = machine(2);
    expect((await m.services.media.mount(dskBytes(), 'x.dsk', 'unit:1')).ok).toBe(true);
    expect(m.fdc.getDiskImage(1)).not.toBeNull();
  });
});

const CACHE = resolve(__dirname, '../../../mcp/.cache');
const ROMS = ['os6128.rom', 'basic1-1.rom', 'amsdos.rom'];
const haveRoms = ROMS.every(r => existsSync(resolve(CACHE, r)));
const rom = (n: string): Uint8Array => new Uint8Array(readFileSync(resolve(CACHE, n)));

function tap(m: CpcMachine, codes: string[]): void {
  for (const c of codes) m.keyboard.handleKeyEvent(c, true);
  for (let f = 0; f < 3; f++) m.tick();
  for (const c of codes) m.keyboard.handleKeyEvent(c, false);
  for (let f = 0; f < 3; f++) m.tick();
}

function type(m: CpcMachine, s: string): void {
  for (const ch of s) {
    if (ch === '"') tap(m, ['ShiftLeft', 'Digit2']);
    else if (ch === '\n') tap(m, ['Enter']);
    else tap(m, ['Key' + ch.toUpperCase()]);
  }
}

describe.skipIf(!haveRoms)('CPC 6128 firmware with one drive', () => {
  it('boots, then SAVEs and CATs on drive A', () => {
    const m = machine(1);
    m.memory.loadRoms(rom('os6128.rom'), rom('basic1-1.rom'), rom('amsdos.rom'));
    m.reset();
    for (let f = 0; f < 150; f++) m.tick();
    expect(m.ocrScreenForMcp()).toContain('Ready');
    m.loadDisk(createBlankDisk(dataFormat()), 0);
    type(m, 'save"zx\n');
    for (let f = 0; f < 100; f++) m.tick();
    type(m, 'cat\n');
    for (let f = 0; f < 100; f++) m.tick();
    const cat = m.ocrScreenForMcp();
    expect(cat).toContain('Drive A: user  0');
    expect(cat).toMatch(/ZX {6}\.BAS/);
  });
});
