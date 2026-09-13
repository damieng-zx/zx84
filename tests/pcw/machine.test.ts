/**
 * PCW machine-level tests: port decode, the &F8 command set, and booting.
 *
 * The port expectations come from Jacob Nevins' PCW I/O notes ("Ports #00-#7F:
 * FDC — A7 from Z80 ties to FDC chip select. Port #00 is status, #01 is data")
 * and the reference's &F8 command list, not from the implementation.
 */

import { describe, expect, it } from 'vitest';
import { PcwMachine } from '@/machines/pcw/pcw-machine.ts';
import { pcwEntry } from '@/machines/pcw/descriptor.ts';
import {
  pcwDefaultPhosphor, pcwDriveType, pcwHasDoubleSidedDriveA,
} from '@/machines/pcw/models.ts';
import { entryForKind, entryForModel } from '@/machines/registry.ts';
import type { DskImage, DskSector, DskTrack } from '@/media/floppy/disk-image.ts';
import {
  PCW_BOOT_ENTRY_ADDR, PCW_BOOT_LOAD_ADDR, PCW_FDC_INT_RESPONSE_LINES, PcwCommand,
} from '@/machines/pcw/constants.ts';

/** A boot sector holding a recognisable payload and summing to &FF. */
function bootDisk(marker = 0xAA): DskImage {
  const data = new Uint8Array(512);
  data[0x10] = marker;
  let sum = 0;
  for (const b of data) sum = (sum + b) & 0xFF;
  data[511] = (0xFF - sum) & 0xFF;

  const sectors: DskSector[] = [
    { c: 0, h: 0, r: 1, n: 2, st1: 0, st2: 0, data },
  ];
  const track: DskTrack = {
    sectors, sectorMap: new Map([[1, 0]]), gap3: 82, filler: 0xE5,
  };
  return {
    format: 'standard', numTracks: 40, numSides: 1,
    tracks: [[track]], diskFormat: 'PCW', protection: '',
  };
}

describe('PCW registry entry', () => {
  it('registers every model under the pcw kind, with no system ROM', () => {
    expect(pcwEntry.kind).toBe('pcw');
    expect([...pcwEntry.models]).toEqual(['pcw8256', 'pcw8512', 'pcw9512', 'pcw9256']);
    expect(entryForKind('pcw')).toBe(pcwEntry);
    for (const model of pcwEntry.models) expect(entryForModel(model)).toBe(pcwEntry);
    // The PCW has no ROM at all — it boots from disc.
    expect(pcwEntry.romSources('pcw8256')).toEqual([]);
  });

  it('fits memory, drives and a printer per model', () => {
    const m8256 = new PcwMachine('pcw8256');
    const m8512 = new PcwMachine('pcw8512');
    const m9512 = new PcwMachine('pcw9512');
    const m9256 = new PcwMachine('pcw9256');
    expect(m8256.memory.blockCount).toBe(16);   // 256K
    expect(m8512.memory.blockCount).toBe(32);   // 512K
    expect(m9512.memory.blockCount).toBe(32);
    expect(m9256.memory.blockCount).toBe(16);   // the budget 9000 kept 256K
    expect(m8256.config.drives).toBe(1);
    expect(m8512.config.drives).toBe(2);        // only the 8512 had two
    expect(m9512.config.drives).toBe(1);
    expect(m9256.config.drives).toBe(1);
    expect(m9512.config.printer).toBe('daisywheel');
    expect(m8256.config.printer).toBe('matrix');
    expect(m9256.config.printer).toBe('matrix'); // the 9256 went back to it
  });
});

describe('PCW port decode', () => {
  it('reaches the FDC from any port with A7 low, A0 choosing the register', () => {
    const m = new PcwMachine('pcw8256');
    // The main status register reads the same at &00 and at &40: A7 is the
    // chip select, so the whole of &00-&7F is the controller.
    const atZero = m.cpu.portIn(0x00);
    expect(m.cpu.portIn(0x40)).toBe(atZero);
    expect(m.cpu.portIn(0x7E)).toBe(atZero);
    // …and not at &80 and above, which is open bus here.
    expect(m.cpu.portIn(0x80)).toBe(0xFF);
  });

  it('pages memory through &F0-&F3 and &F4', () => {
    const m = new PcwMachine('pcw8256');
    m.memory.getRamBank(5)[0] = 0x5F;
    m.cpu.portOut(0xF0, 0x85);                 // block 5, read and write
    expect(m.memory.readByte(0x0000)).toBe(0x5F);
    m.cpu.portOut(0xF4, 0x40);                 // b6 = block at &0000
    expect(m.memory.memctl).toBe(0x40);
  });

  it('routes the video registers to the gate array', () => {
    const m = new PcwMachine('pcw8256');
    m.cpu.portOut(0xF5, 0x5B);
    m.cpu.portOut(0xF6, 0x03);
    m.cpu.portOut(0xF7, 0xC0);
    expect(m.asic.rollerAddress).toBe(0xB600);
    expect(m.asic.verticalPos).toBe(3);
    expect(m.asic.videoCtl).toBe(0xC0);
  });

  it('reads the system status from &F8 and &F4, clearing the count only on &F4', () => {
    const m = new PcwMachine('pcw8256');
    m.asic.beginLine(258);                     // one 300Hz tick pending
    expect(m.cpu.portIn(0xF8) & 0x0F).toBe(1);
    expect(m.cpu.portIn(0xF8) & 0x0F).toBe(1);
    expect(m.cpu.portIn(0xF4) & 0x0F).toBe(1);
    expect(m.cpu.portIn(0xF8) & 0x0F).toBe(0);
  });
});

describe('PCW system commands (&F8 out)', () => {
  it('treats the byte as a command number, not a bit field', () => {
    const m = new PcwMachine('pcw8256');

    m.cpu.portOut(0xF8, PcwCommand.MotorOn);
    expect(m.fdc.motorOn).toBe(true);
    m.cpu.portOut(0xF8, PcwCommand.MotorOff);
    expect(m.fdc.motorOn).toBe(false);

    m.cpu.portOut(0xF8, PcwCommand.ScreenOff);
    expect(m.asic.screenEnabled).toBe(false);
    m.cpu.portOut(0xF8, PcwCommand.ScreenOn);
    expect(m.asic.screenEnabled).toBe(true);

    m.cpu.portOut(0xF8, PcwCommand.BeepOn);
    expect(m.beeperBit).toBe(1);
    m.cpu.portOut(0xF8, PcwCommand.BeepOff);
    expect(m.beeperBit).toBe(0);

    m.cpu.portOut(0xF8, PcwCommand.FdcToNmi);
    expect(m.asic.fdcRoute).toBe('nmi');
    m.cpu.portOut(0xF8, PcwCommand.FdcToInt);
    expect(m.asic.fdcRoute).toBe('int');
    m.cpu.portOut(0xF8, PcwCommand.FdcToNeither);
    expect(m.asic.fdcRoute).toBe('none');
  });

  it('gives the FDC a command response time, and charges it per scan line', () => {
    // The PCW is the one machine here that waits on the FDC's interrupt rather
    // than polling it, so it is the one that has to stop the controller
    // answering inside the window its BIOS arms a wait in.
    const m = new PcwMachine('pcw8256');
    expect(m.fdc.intResponseTicks).toBe(PCW_FDC_INT_RESPONSE_LINES);

    m.cpu.portOut(0xF8, PcwCommand.FdcToInt);
    m.cpu.portOut(0x01, 0x04);                 // SENSE DRIVE STATUS
    m.cpu.portOut(0x01, 0x00);                 // result is ready at once...
    expect(m.fdc.interruptLine).toBe(false);   // ...but INT is not
    expect(m.cpu.portIn(0xF8) & 0x20).toBe(0);

    // A frame is far more than the response time, so the line is up by the end
    // of it — which also proves the per-line tick is actually wired in.
    m.tick();
    expect(m.fdc.interruptLine).toBe(true);
    expect(m.cpu.portIn(0xF8) & 0x20).toBe(0x20);
  });

  it('ignores command numbers past the documented set', () => {
    // Command 9 is motor-on; 25 must NOT be treated as 9 with spare bits.
    const m = new PcwMachine('pcw8256');
    m.cpu.portOut(0xF8, 25);
    expect(m.fdc.motorOn).toBe(false);
  });
});

describe('PCW booting', () => {
  it('loads the boot sector to &F000 and enters at &F010', () => {
    const m = new PcwMachine('pcw8256');
    m.loadDisk(bootDisk(0xAA));
    expect(m.booted).toBe(true);
    expect(m.cpu.pc).toBe(PCW_BOOT_ENTRY_ADDR);
    expect(m.memory.readByte(PCW_BOOT_LOAD_ADDR + 0x10)).toBe(0xAA);
  });

  it('refuses a disc whose boot sector does not checksum', () => {
    const m = new PcwMachine('pcw8256');
    const bad = bootDisk();
    bad.tracks[0][0]!.sectors[0].data[0x20] = 0x01;   // break the sum
    m.loadDisk(bad);
    expect(m.booted).toBe(false);
    expect(m.cpu.pc).toBe(0x0000);
  });

  it('runs a frame without a disc instead of failing', () => {
    // Nothing is mounted, so the CPU sits executing zeroed RAM. It must still
    // clock through a whole field: the shell starts the machine either way.
    const m = new PcwMachine('pcw8256');
    expect(m.booted).toBe(false);
    expect(() => m.tick()).not.toThrow();
  });
});

describe('PCW drives and monitor per model', () => {
  it('gives drive A the right mechanism and the synth the right profile', () => {
    // The 8256's A: is the single-sided 180K CF2; the 9512 got a double-sided
    // 720K CF2, and the 1991 9256 is where the range moved to 3.5".
    expect(pcwHasDoubleSidedDriveA('pcw8256')).toBe(false);
    expect(pcwHasDoubleSidedDriveA('pcw8512')).toBe(false);
    expect(pcwHasDoubleSidedDriveA('pcw9512')).toBe(true);
    expect(pcwHasDoubleSidedDriveA('pcw9256')).toBe(true);

    expect(pcwDriveType('pcw8256')).toBe('3inch');
    expect(pcwDriveType('pcw8512')).toBe('3inch');
    expect(pcwDriveType('pcw9512')).toBe('3inch');
    expect(pcwDriveType('pcw9256')).toBe('3.5inch');
  });

  it('paints white phosphor on the 9512 alone', () => {
    expect(pcwDefaultPhosphor('pcw9512')).toBe('white');
    for (const model of ['pcw8256', 'pcw8512', 'pcw9256'] as const) {
      expect(pcwDefaultPhosphor(model)).toBe('green');
    }
  });
});
