/**
 * MSX MediaService routing: `.rom` cartridges (auto-booted) and cassettes
 * (`.cas` on the deck and for the BIOS traps; `.tsx`/`.tzx`/`.wav` on the deck
 * only); everything else refused. ZIP unwrapping stays a
 * shell concern. Tests run headless against a real MsxMachine (display = null).
 * Disk images are accepted only while the optional floppy interface is fitted
 * (see tests/msx/msx-disk-interface.test.ts).
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

  it('.cas mounts on the deck with PLAY pressed and on the BIOS-trap stream', async () => {
    const m = machine();
    const r = await m.services.media.mount(tinyCas(), 'game.cas');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('tape');
    expect(m.cassette.loaded).toBe(true);
    expect(m.cassette.name).toBe('game.cas');
    expect(m.services.tape.loaded).toBe(true);
    expect(m.services.tape.rawBlocks).toHaveLength(1);
    expect(m.tape.playing && !m.tape.paused).toBe(true);
  });

  it('a .wav goes on the deck only (no byte stream for the traps)', async () => {
    const m = machine();
    // 16-bit mono PCM, 8 samples of a square wave.
    const pcm = new Int16Array([16000, 16000, -16000, -16000, 16000, 16000, -16000, -16000]);
    const wav = new Uint8Array(44 + pcm.byteLength);
    const v = new DataView(wav.buffer);
    const tag = (o: number, t: string) => { for (let i = 0; i < 4; i++) wav[o + i] = t.charCodeAt(i); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); tag(8, 'WAVE');
    tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 44100, true); v.setUint32(28, 88200, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    tag(36, 'data'); v.setUint32(40, pcm.byteLength, true);
    wav.set(new Uint8Array(pcm.buffer), 44);
    const r = await m.services.media.mount(wav, 'game.wav');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('tape');
    expect(m.services.tape.loaded).toBe(true);
    expect(m.cassette.loaded).toBe(false);
  });

  it('a damaged tape is refused', async () => {
    const r = await machine().services.media.mount(new Uint8Array([1, 2, 3]), 'game.tsx');
    expect(r.ok).toBe(false);
  });

  it('accepts() offers .rom, the cassette formats and its .msxstate snapshot', () => {
    const exts = machine().services.media.accepts().map(t => t.ext);
    expect(exts).toEqual(['.rom', '.cas', '.tsx', '.tzx', '.wav', '.msxstate']);
  });

  it('has a cartridge slot, a .msxstate snapshot service and no drives until the disk interface is fitted', () => {
    const m = machine();
    expect(m.services.roms.cartridge).not.toBeNull();
    expect(m.services.disks.drives).toEqual([]);
    expect(m.services.snapshots?.formats()).toEqual([{ ext: '.msxstate', canSave: true }]);
  });

  it('unknown extensions are refused with the MSX media list', async () => {
    const m = machine();
    const r = await m.services.media.mount(new Uint8Array(4), 'game.xyz');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/MSX accepts/);
  });

  it('a disk image is refused, pointing at the Hardware pane, while no interface is fitted', async () => {
    const m = machine();
    const r = await m.services.media.mount(new Uint8Array(368640), 'game.dsk');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/disk interface/i);
  });
});
