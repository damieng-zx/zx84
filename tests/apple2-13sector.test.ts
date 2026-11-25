/**
 * A Disk ][ card had either the 13- or the 16-sector boot PROM. zx84 keeps
 * both and swaps the one in slot 6 when the drive-1 disk changes, so a 13-
 * sector image (.d13, an RDOS 2.1 nibble image, ...) boots without rebuilding
 * the machine. The PROM's last byte is the card signature software reads:
 * $FF for 13-sector, $00 for 16-sector.
 */

import { describe, it, expect } from 'vitest';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';

/** 35 tracks x 13 sectors x 256 bytes: the .d13 length. */
const D13_SIZE = 35 * 13 * 256;
/** 35 tracks x 16 sectors x 256 bytes: a plain sector image. */
const DO_SIZE = 35 * 16 * 256;

function fakeRom(signature: number): Uint8Array {
  const rom = new Uint8Array(256).fill(0xEA);
  rom[0xFF] = signature;
  return rom;
}

function machine(): Apple2Machine {
  const m = new Apple2Machine('apple2-plus', null);
  m.installDisk2BootRoms(fakeRom(0x00), fakeRom(0xFF));
  return m;
}

function slot6(m: Apple2Machine): Uint8Array { return m.memory.slotRom[6]!; }

describe('Disk ][ boot PROM selection', () => {
  it('starts on the 16-sector PROM', () => {
    const m = machine();
    try {
      expect(m.disk2BootRomSectors).toBe(16);
      expect(slot6(m)[0xFF]).toBe(0x00);   // 16-sector card signature
    } finally { m.destroy(); }
  });

  it('swaps in the 13-sector PROM for a .d13 in drive 1', async () => {
    const m = machine();
    try {
      const r = await m.services.media.mount(new Uint8Array(D13_SIZE), 'test.d13', 'a');
      expect(r.ok).toBe(true);
      expect(m.disk2BootRomSectors).toBe(13);
      expect(slot6(m)[0xFF]).toBe(0xFF);   // 13-sector card signature
    } finally { m.destroy(); }
  });

  it('goes back to the 16-sector PROM when the 13-sector disk is ejected', async () => {
    const m = machine();
    try {
      await m.services.media.mount(new Uint8Array(D13_SIZE), 'test.d13', 'a');
      m.services.disks!.eject('a');
      expect(m.disk2BootRomSectors).toBe(16);
      expect(slot6(m)[0xFF]).toBe(0x00);
    } finally { m.destroy(); }
  });

  it('does not change the PROM for a 13-sector disk in drive 2', async () => {
    const m = machine();
    try {
      await m.services.media.mount(new Uint8Array(DO_SIZE), 'boot.dsk', 'a');
      await m.services.media.mount(new Uint8Array(D13_SIZE), 'data.d13', 'b');
      expect(m.disk2BootRomSectors).toBe(16);
      expect(slot6(m)[0xFF]).toBe(0x00);
    } finally { m.destroy(); }
  });

  it('keeps the 16-sector PROM when the 13-sector ROM was not fetched', async () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      m.installDisk2BootRoms(fakeRom(0x00), null);
      expect(m.hasDisk2Rom13).toBe(false);
      await m.services.media.mount(new Uint8Array(D13_SIZE), 'test.d13', 'a');
      expect(m.disk2BootRomSectors).toBe(16);
      expect(slot6(m)[0xFF]).toBe(0x00);
    } finally { m.destroy(); }
  });
});
