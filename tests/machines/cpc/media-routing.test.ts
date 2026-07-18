/**
 * CPC MediaService routing — extension → device matrix, ported verbatim from
 * the pre-service emulator.loadFile asCpc branch (+ loadCpcSnapshot): .cdt/.tzx/
 * .tap → cassette, .sna → snapshot (with model auto-switch), .dsk/.hfe/.scp →
 * uPD765A, everything else refused. Tests run headless against a real CpcMachine
 * (display = null).
 */

import { describe, it, expect } from 'vitest';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import type { MachineHost } from '@/machines/machine.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { blankMgtDisk } from '@/media/floppy/mgt-image.ts';

/** Minimal valid TAP: one 3-byte block (flag, one payload byte, checksum). */
function tinyTap(): Uint8Array {
  const flag = 0xff, payload = 0x41;
  return new Uint8Array([3, 0, flag, payload, flag ^ payload]);
}

const dskBytes = () => serializeDSK(blankMgtDisk(40, 1));

/** A `.SNA` header (256 bytes) for a given CPC model — enough for
 *  readCpcSnaModel to identify it (signature + version + type byte). */
function snaHeader(type: 0 | 1 | 2, version = 2): Uint8Array {
  const d = new Uint8Array(256);
  d.set([0x4d, 0x56, 0x20, 0x2d, 0x20, 0x53, 0x4e, 0x41], 0);   // "MV - SNA"
  d[0x10] = version;
  d[0x6d] = type;   // 0=464, 1=664, 2=6128
  return d;
}

function machine(model: 'cpc464' | 'cpc6128' = 'cpc6128'): CpcMachine {
  const c = new CpcMachine(model, null);
  c.start = async () => {};   // headless: no AudioContext / rAF
  return c;
}

function hostStub(grant: boolean) {
  const calls: { model: string; reason: string }[] = [];
  const host: MachineHost = {
    setStatus: () => {},
    requestModel: async (model, reason) => { calls.push({ model, reason }); return grant; },
    persistMedia: () => {},
  };
  return { host, calls };
}

describe('CPC MediaService routing', () => {
  it('.tap mounts on the tape deck, positioned at start, play-paused', async () => {
    const c = machine();
    const r = await c.services.media.mount(tinyTap(), 'game.tap');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('tape');
    expect(c.tape.blocks.length).toBe(1);
    expect(c.tape.position).toBe(0);
    expect(c.tape.paused).toBe(true);
    expect(c.tape.playing).toBe(true);
  });

  it('.dsk mounts in the uPD765A (drive A by default, B via unit hint)', async () => {
    const c = machine('cpc6128');
    const a = await c.services.media.mount(dskBytes(), 'game.dsk');
    expect(a.ok).toBe(true);
    expect(a.target).toBe('a');
    expect(c.fdc.getDiskImage(0)).not.toBeNull();
    const b = await c.services.media.mount(dskBytes(), 'other.dsk', 'unit:1');
    expect(b.target).toBe('b');
    expect(c.fdc.getDiskImage(1)).not.toBeNull();
  });

  it('.dsk accepts() only when a floppy controller is fitted', () => {
    expect(machine('cpc6128').services.media.accepts().map(t => t.ext)).toContain('.dsk');
    expect(machine('cpc464').services.media.accepts().map(t => t.ext)).not.toContain('.dsk');
  });

  it('a .sna for a different model asks the host to rebuild and flags a replay', async () => {
    const c = machine('cpc6128');
    const { host, calls } = hostStub(true);
    c.attachHost(host);
    const r = await c.services.media.mount(snaHeader(0), 'game.sna');   // 464 sna on a 6128
    expect(calls).toEqual([{ model: 'cpc464', reason: expect.stringContaining('game.sna') }]);
    expect(r.ok).toBe(true);
    expect(r.replay).toBe(true);
  });

  it('a bad .sna signature is reported as an error', async () => {
    const c = machine('cpc6128');
    const r = await c.services.media.mount(new Uint8Array(256), 'bad.sna');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/SNA error/);
  });

  it('unknown extensions are refused with the CPC media list', async () => {
    const c = machine('cpc6128');
    const r = await c.services.media.mount(new Uint8Array(4), 'file.xyz');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/CPC accepts/);
  });
});
