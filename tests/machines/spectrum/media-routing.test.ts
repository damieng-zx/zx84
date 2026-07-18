/**
 * Spectrum MediaService routing — extension × peripheral-enable matrix.
 *
 * These expectations are the behaviour of the pre-service loadFile cascade
 * (emulator.ts) captured verbatim, per docs/re-architecture.md §8: the
 * .hfe/.scp precedence (Beta Disk → +D → uPD765A) and the IF2 capability
 * gating are load-bearing and must survive the routing's move into the
 * machine. Tests run headless against a real Spectrum (display = null).
 */

import { describe, it, expect } from 'vitest';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import type { MachineHost } from '@/machines/machine.ts';
import { Microdrive } from '@/machines/spectrum/peripherals/microdrive.ts';
import { blankTrdDisk, serializeTrd } from '@/media/floppy/trd-image.ts';
import { blankMgtDisk, serializeMgt } from '@/media/floppy/mgt-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { serializeHFE, attachHfeBitstream } from '@/media/floppy/hfe.ts';

// ── Media fabrication ─────────────────────────────────────────────────────

/** Minimal valid TAP: one 3-byte block (flag, one payload byte, checksum). */
function tinyTap(): Uint8Array {
  const flag = 0xff, payload = 0x41;
  return new Uint8Array([3, 0, flag, payload, flag ^ payload]);
}

const trdBytes = () => serializeTrd(blankTrdDisk(80, 2));
const mgtBytes = () => serializeMgt(blankMgtDisk(80, 2), 'mgt');
const dskBytes = () => serializeDSK(blankMgtDisk(40, 1));
const hfeBytes = () => serializeHFE(attachHfeBitstream(blankMgtDisk(80, 2)));
function mdrBytes(): Uint8Array {
  const md = new Microdrive();
  md.format('TEST');
  return md.toMDR();
}
/** 48K .sna is exactly 49179 bytes; larger means 128K. */
const sna48 = () => new Uint8Array(49179);
const sna128 = () => new Uint8Array(131103);

function machine(model: '48k' | '+3' = '48k'): Spectrum {
  const s = new Spectrum(model, null);
  // Headless: the mounts call start()/stop() around device swaps (as the
  // shell paths always did); a real start() would touch AudioContext/rAF.
  s.start = async () => {};
  return s;
}

function hostStub(grantModelSwitch: boolean) {
  const calls: { model: string; reason: string }[] = [];
  const host: MachineHost = {
    setStatus: () => {},
    requestModel: async (model, reason) => { calls.push({ model, reason }); return grantModelSwitch; },
    persistMedia: () => {},
  };
  return { host, calls };
}

// ── Routing matrix ────────────────────────────────────────────────────────

describe('Spectrum MediaService routing', () => {
  it('.tap mounts on the tape deck, positioned at start, play-paused', async () => {
    const s = machine();
    const r = await s.services.media.mount(tinyTap(), 'game.tap');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('tape');
    expect(s.tape.blocks.length).toBe(1);
    expect(s.tape.position).toBe(0);
    expect(s.tape.paused).toBe(true);
    expect(s.tape.playing).toBe(true);
  });

  it('.dsk on a +3 mounts in the uPD765A (drive A by default, B via unit hint)', async () => {
    const s = machine('+3');
    const a = await s.services.media.mount(dskBytes(), 'game.dsk');
    expect(a.ok).toBe(true);
    expect(a.target).toBe('a');
    expect(s.fdc.getDiskImage(0)).not.toBeNull();
    const b = await s.services.media.mount(dskBytes(), 'other.dsk', 'unit:1');
    expect(b.target).toBe('b');
    expect(s.fdc.getDiskImage(1)).not.toBeNull();
  });

  it('.dsk on a 48K still parses into the (unused) uPD765A — pre-service quirk preserved', async () => {
    const s = machine('48k');
    const r = await s.services.media.mount(dskBytes(), 'game.dsk');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('a');
  });

  it('.trd routes to the Beta Disk when enabled, and is refused when not', async () => {
    const s = machine();
    expect((await s.services.media.mount(trdBytes(), 'g.trd')).message)
      .toMatch(/Enable the Beta Disk/);
    s.betaDisk.enabled = true;
    const r = await s.services.media.mount(trdBytes(), 'g.trd');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('beta:0');
    expect(s.betaDisk.fdc.getDiskImage(0)).not.toBeNull();
  });

  it('.mgt routes to the +D when enabled, and is refused when not', async () => {
    const s = machine();
    expect((await s.services.media.mount(mgtBytes(), 'g.mgt')).message)
      .toMatch(/Enable the MGT \+D/);
    s.mgtPlusD.enabled = true;
    const r = await s.services.media.mount(mgtBytes(), 'g.mgt', 'unit:1');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('plusd:1');
    expect(s.mgtPlusD.fdc.getDiskImage(1)).not.toBeNull();
  });

  it('.hfe precedence: Beta Disk beats +D when both are enabled', async () => {
    const s = machine();
    s.betaDisk.enabled = true;
    s.mgtPlusD.enabled = true;
    const r = await s.services.media.mount(hfeBytes(), 'flux.hfe');
    expect(r.target).toBe('beta:0');
    expect(s.betaDisk.fdc.getDiskImage(0)).not.toBeNull();
    expect(s.mgtPlusD.fdc.getDiskImage(0)).toBeNull();
  });

  it('.hfe routes to the +D when only the +D is enabled (no built-in FDC)', async () => {
    const s = machine();
    s.mgtPlusD.enabled = true;
    const r = await s.services.media.mount(hfeBytes(), 'flux.hfe');
    expect(r.target).toBe('plusd:0');
  });

  it('.hfe on a +3 falls through to the uPD765A (never the +D)', async () => {
    const s = machine('+3');
    const r = await s.services.media.mount(hfeBytes(), 'flux.hfe');
    expect(r.target).toBe('a');
    expect(s.fdc.getDiskImage(0)).not.toBeNull();
  });

  it('.mdr routes to the Interface 1 when enabled, and is refused when not', async () => {
    const s = machine();
    expect((await s.services.media.mount(mdrBytes(), 'c.mdr')).message)
      .toMatch(/Enable the ZX Interface 1/);
    s.interface1.enabled = true;
    const r = await s.services.media.mount(mdrBytes(), 'c.mdr', 'unit:2');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('mdv:2');
    expect(s.interface1.drives[2].inserted).toBe(true);
  });

  it('.rom inserts an IF2 cartridge on a 48K, is unknown on a +3', async () => {
    const s48 = machine('48k');
    const r48 = await s48.services.media.mount(new Uint8Array(16384), 'game.rom');
    expect(r48.ok).toBe(true);
    expect(r48.target).toBe('cartridge');
    expect(s48.interface2.name).toBe('game.rom');

    const s3 = machine('+3');
    const r3 = await s3.services.media.mount(new Uint8Array(16384), 'game.rom');
    expect(r3.ok).toBe(false);
    expect(r3.message).toMatch(/Unknown file type/);
  });

  it('48K .sna applies directly (no model upgrade)', async () => {
    const s = machine('48k');
    const { host, calls } = hostStub(true);
    s.attachHost(host);
    const r = await s.services.media.mount(sna48(), 'game.sna');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('snapshot');
    expect(calls.length).toBe(0);
  });

  it('128K .sna on a 48K asks the host for a 128K model and flags a replay', async () => {
    const s = machine('48k');
    const { host, calls } = hostStub(true);
    s.attachHost(host);
    const r = await s.services.media.mount(sna128(), 'game128.sna');
    expect(calls).toEqual([{ model: '128k', reason: expect.stringContaining('game128.sna') }]);
    expect(r.ok).toBe(true);
    expect(r.replay).toBe(true);
  });

  it('128K .sna on a 48K fails cleanly when the host declines the upgrade', async () => {
    const s = machine('48k');
    const { host } = hostStub(false);
    s.attachHost(host);
    const r = await s.services.media.mount(sna128(), 'game128.sna');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/128K SNA requires a 128K ROM/);
  });

  it('unknown extensions are rejected with a status message', async () => {
    const s = machine();
    const r = await s.services.media.mount(new Uint8Array(4), 'file.xyz');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unknown file type: \.xyz/);
  });

  it('accepts() varies with model capability: +3 offers .dsk, 48K offers .rom/.mdr instead', () => {
    const exts48 = machine('48k').services.media.accepts().map(t => t.ext);
    expect(exts48).toContain('.rom');
    expect(exts48).toContain('.mdr');
    expect(exts48).not.toContain('.dsk');

    const exts3 = machine('+3').services.media.accepts().map(t => t.ext);
    expect(exts3).toContain('.dsk');
    expect(exts3).toContain('.hfe');
    expect(exts3).not.toContain('.rom');
    expect(exts3).not.toContain('.mdr');
  });
});
