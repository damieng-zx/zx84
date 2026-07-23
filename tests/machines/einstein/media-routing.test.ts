/**
 * Einstein MediaService routing — ported verbatim from the pre-service
 * emulator.loadFile asEinstein branch: only disk images (.dsk/.hfe/.scp) read by
 * the WD1772; everything else refused. ZIP unwrapping stays a shell concern.
 * Tests run headless against a real EinsteinMachine (display = null).
 */

import { describe, it, expect } from 'vitest';
import { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { serializeHFE, attachHfeBitstream } from '@/media/floppy/hfe.ts';
import { blankMgtDisk } from '@/media/floppy/mgt-image.ts';

const dskBytes = () => serializeDSK(blankMgtDisk(40, 1));
const hfeBytes = () => serializeHFE(attachHfeBitstream(blankMgtDisk(80, 2)));

function machine(): EinsteinMachine {
  const e = new EinsteinMachine('einstein-tc01', null);
  e.start = async () => {};   // headless: no AudioContext / rAF
  return e;
}

describe('Einstein MediaService routing', () => {
  it('.dsk mounts in the WD1772 (drive 0 by default, drive 1 via unit hint)', async () => {
    const e = machine();
    const a = await e.services.media.mount(dskBytes(), 'game.dsk');
    expect(a.ok).toBe(true);
    expect(a.target).toBe('a');
    expect(a.message).toMatch(/Drive 0: loaded/);
    expect(e.fdc.getDiskImage(0)).not.toBeNull();
    const b = await e.services.media.mount(dskBytes(), 'other.dsk', 'unit:1');
    expect(b.target).toBe('b');
    expect(b.message).toMatch(/Drive 1: loaded/);
    expect(e.fdc.getDiskImage(1)).not.toBeNull();
  });

  it('.hfe flux images route to the WD1772 too', async () => {
    const e = machine();
    const r = await e.services.media.mount(hfeBytes(), 'flux.hfe');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('a');
    expect(e.fdc.getDiskImage(0)).not.toBeNull();
  });

  it('accepts() offers .dsk/.hfe/.scp (no tape, no cartridge)', () => {
    const exts = machine().services.media.accepts().map(t => t.ext);
    expect(exts).toEqual(['.dsk', '.hfe', '.scp']);
  });

  it('has no cassette or snapshot service', () => {
    const e = machine();
    expect(e.services.tape).toBeNull();
    expect(e.services.snapshots).toBeNull();
  });

  it('non-disk files are refused with the Einstein media list', async () => {
    const e = machine();
    const r = await e.services.media.mount(new Uint8Array(4), 'game.tap');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Einstein accepts/);
  });
});
