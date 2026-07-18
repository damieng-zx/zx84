/**
 * MSX MediaService routing — ported verbatim from the pre-service
 * emulator.loadFile asMsx branch: `.rom` cartridges (auto-booted) and `.cas`
 * cassettes (BIOS-trap load); everything else refused. ZIP unwrapping stays a
 * shell concern. Tests run headless against a real MsxMachine (display = null).
 */

import { describe, it, expect } from 'vitest';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';

/** A minimal `.cas`: the 8-byte sync ID followed by a byte of data. */
function tinyCas(): Uint8Array {
  return new Uint8Array([0x1f, 0xa6, 0xde, 0xba, 0xcc, 0x13, 0x7d, 0x74, 0x42]);
}

function machine(): MsxMachine {
  const m = new MsxMachine('hx-10', null);
  m.start = async () => {};   // headless: no AudioContext / rAF
  return m;
}

describe('MSX MediaService routing', () => {
  it('.rom inserts a cartridge and power-cycles the machine', async () => {
    const m = machine();
    const r = await m.services.media.mount(new Uint8Array(16384), 'game.rom');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('cartridge');
    expect(m.cartridgeName).toBe('game.rom');
    expect(m.services.roms.cartridge.name).toBe('game.rom');
  });

  it('.cas mounts on the cassette (served through the BIOS load traps)', async () => {
    const m = machine();
    const r = await m.services.media.mount(tinyCas(), 'game.cas');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('cas');
    expect(m.cassette.loaded).toBe(true);
    expect(m.cassette.name).toBe('game.cas');
    expect(m.services.tape.loaded).toBe(true);
  });

  it('accepts() offers .rom and .cas', () => {
    const exts = machine().services.media.accepts().map(t => t.ext);
    expect(exts).toEqual(['.rom', '.cas']);
  });

  it('has a cartridge slot but no disk or snapshot service', () => {
    const m = machine();
    expect(m.services.roms.cartridge).not.toBeNull();
    expect(m.services.disks).toBeNull();
    expect(m.services.snapshots).toBeNull();
  });

  it('unknown extensions are refused with the MSX media list', async () => {
    const m = machine();
    const r = await m.services.media.mount(new Uint8Array(4), 'game.dsk');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/MSX accepts/);
  });
});
