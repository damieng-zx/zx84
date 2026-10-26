/**
 * Atari ROM sockets: the OS and BASIC as two independently replaceable ROMs,
 * defaulting to AltirraOS and Altirra BASIC.
 *
 * Expected behaviour:
 *  - the ROM pane lists an OS socket and a BASIC socket (and no separate
 *    system socket), named after the default firmware: the 10K 400/800 OS or
 *    the 16K XL/XE one, and the 8K BASIC;
 *  - a user image goes over the default in its socket only: a custom OS on an
 *    800XL leaves the built-in BASIC where it was;
 *  - where BASIC is a cartridge (400/800/1200XL) the user BASIC takes the
 *    place of the default one the shell mounts under an empty name;
 *  - an image of the wrong size is refused with a message, and never stored.
 */

import { describe, it, expect, vi } from 'vitest';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { atariEntry } from '@/machines/atari/descriptor.ts';
import type { MachineHost } from '@/machines/machine.ts';

function withHost(m: AtariMachine) {
  const roms = {
    persistSideways: vi.fn(async () => {}),
    clearSideways: vi.fn(async () => {}),
    rebuild: vi.fn(async () => {}),
  };
  m.attachHost({ roms } as unknown as MachineHost);
  return roms;
}

describe('atari ROM sockets', () => {
  it('list the OS and BASIC with the default firmware names and no system socket', () => {
    const m800 = new AtariMachine('atari800', null);
    const xl = new AtariMachine('atari800xl', null);
    try {
      expect(m800.services.roms.systemSlots).toEqual([]);
      expect(atariEntry.descriptor('atari800').ui.systemRomSlot).toBe(false);
      expect(m800.services.roms.sidewaysSlots).toEqual([
        { index: 0, title: 'OS ROM', label: 'AltirraOS 3.44 (400/800)', size: 0x2800, overridden: false },
        { index: 1, title: 'BASIC ROM', label: 'Altirra BASIC 1.59', size: 0x2000, overridden: false },
      ]);
      expect(xl.services.roms.sidewaysSlots.map(s => [s.label, s.size])).toEqual([
        ['AltirraOS 3.44 (XL/XE)', 0x4000],
        ['Altirra BASIC 1.59', 0x2000],
      ]);
    } finally {
      m800.destroy();
      xl.destroy();
    }
  });

  it('replace the OS without touching BASIC', () => {
    const m = new AtariMachine('atari800xl', null);
    try {
      m.memory.loadRom(new Uint8Array([...new Uint8Array(0x4000).fill(0x11), ...new Uint8Array(0x2000).fill(0xba)]));
      m.services.roms.installSidewaysRom!(0, new Uint8Array(0x4000).fill(0x77));
      expect(m.memory.osRom[0]).toBe(0x77);
      expect(m.memory.osRom[0x3fff]).toBe(0x77);
      expect(m.memory.basicRom![0]).toBe(0xba);
    } finally {
      m.destroy();
    }
  });

  it('replace the built-in BASIC of an XL without touching the OS', () => {
    const m = new AtariMachine('atari130xe', null);
    try {
      m.memory.loadRom(new Uint8Array([...new Uint8Array(0x4000).fill(0x11), ...new Uint8Array(0x2000).fill(0xba)]));
      m.services.roms.installSidewaysRom!(1, new Uint8Array(0x2000).fill(0x42));
      expect(m.memory.basicRom![0x1fff]).toBe(0x42);
      expect(m.memory.osRom[0]).toBe(0x11);
    } finally {
      m.destroy();
    }
  });

  it('put a user BASIC where the default BASIC cartridge would go', () => {
    const m = new AtariMachine('atari800', null);
    try {
      const mine = new Uint8Array(0x2000).fill(0x42);
      m.services.roms.installSidewaysRom!(1, mine);
      // The shell mounts the default BASIC under an empty name.
      m.services.roms.cartridge!.insert(new Uint8Array(0x2000).fill(0x99), '');
      expect(m.memory.cart!.read(0xa000)).toBe(0x42);
      expect(m.hiddenBasic![0]).toBe(0x42);
      // A real cartridge the user loads is theirs, not replaced.
      m.services.roms.cartridge!.insert(new Uint8Array(0x2000).fill(0x55), 'game.rom');
      expect(m.memory.cart!.read(0xa000)).toBe(0x55);
    } finally {
      m.destroy();
    }
  });

  it('refuse an image of the wrong size, and store nothing', async () => {
    const m = new AtariMachine('atari800', null);
    try {
      const roms = withHost(m);
      const status = vi.fn();
      m.onStatus = status;
      await m.services.roms.setSidewaysRom!(0, new Uint8Array(0x4000), 'xl.rom'); // an XL OS in a 400/800
      await m.services.roms.setSidewaysRom!(1, new Uint8Array(0x1000), 'small.rom');
      expect(roms.persistSideways).not.toHaveBeenCalled();
      expect(roms.rebuild).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(expect.stringContaining('the 10K OS of the Atari 800 needs 10240'));
      expect(status).toHaveBeenCalledWith(expect.stringContaining('the 8K BASIC needs 8192'));
    } finally {
      m.destroy();
    }
  });

  it('store a good image per socket and rebuild; reverting clears it', async () => {
    const m = new AtariMachine('atari800', null);
    try {
      const roms = withHost(m);
      const os = new Uint8Array(0x2800);
      await m.services.roms.setSidewaysRom!(0, os, 'atarios.rom');
      expect(roms.persistSideways).toHaveBeenCalledWith(0, os, 'atarios.rom');
      expect(roms.rebuild).toHaveBeenCalledTimes(1);
      await m.services.roms.resetSidewaysRom!(0);
      expect(roms.clearSideways).toHaveBeenCalledWith(0);
      expect(roms.rebuild).toHaveBeenCalledTimes(2);
    } finally {
      m.destroy();
    }
  });
});
