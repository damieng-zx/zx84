/**
 * The disk drives on the VIC-20's serial bus: the VIC-20's side of the bus
 * through its VIAs, the drives' side read back on VIA 1, and disks dropped on
 * the machine.
 *
 * From the VIC-20's wiring: ATN out is VIA 1 PA7, CLK out VIA 2 CA2 and DATA
 * out VIA 2 CB2, each through an inverter (an output held high pulls its line
 * low; the KERNAL's CLKHI clears the CA2 output bit); CLK in is VIA 1 PA0
 * and DATA in VIA 1 PA1, reading the lines as they are. From the 1541: its
 * VIA 1 port B reads ATN, CLK and DATA inverted (bits 7, 2, 0 set while the
 * line is low), drives CLK and DATA low from bits 3 and 1, and holds DATA
 * low in hardware while ATN is asserted and ATNA (bit 4) disagrees.
 */

import { describe, it, expect } from 'vitest';
import type { Drive1541 } from '@/machines/shared/cbm/drive/drive-1541.ts';
import { parseD64 } from '@/media/floppy/c64-disk.ts';
import { d64WithFiles } from '../c64/d64-helper.ts';
import { firmware, machine } from './firmware.ts';

/** The drive's own bus registers, as the 1541 tests reach them. */
interface DriveBus {
  busWrite(addr: number, value: number): void;
  busRead(addr: number): number;
}
const bus = (d: Drive1541): DriveBus => d as unknown as DriveBus;

function withDrive() {
  const m = machine(firmware());
  m.iec.fitDrives(['1541']);
  const d = m.drives[0] as Drive1541;
  d.insertDisk(parseD64(d64WithFiles([])), false, 'bare.d64', true);
  // VIA 1 port A: PA7 (ATN out) an output, the rest inputs.
  m.memory.writeByte(0x9113, 0x80);
  m.memory.writeByte(0x9111, 0x00);
  // VIA 2: CA2 and CB2 held low (CLK and DATA released).
  m.memory.writeByte(0x912C, 0xCC);
  return { m, d };
}

describe('VIC-20 serial bus', () => {
  it('asserts ATN from VIA 1 PA7, and the drive acknowledges by holding DATA low', () => {
    const { m, d } = withDrive();
    expect(d.dataAsserted).toBe(false);
    expect(m.memory.readByte(0x911F) & 0x02, 'DATA in high').toBe(0x02);
    m.memory.writeByte(0x911F, 0x80);                 // ATN out
    expect(bus(d).busRead(0x1800) & 0x80, 'the drive sees ATN low').toBe(0x80);
    expect(d.dataAsserted, 'hardware acknowledge').toBe(true);
    expect(m.memory.readByte(0x911F) & 0x02, 'DATA in now low').toBe(0);
    m.destroy();
  });

  it('pulls CLK low with CA2 held high and DATA low with CB2 held high', () => {
    const { m, d } = withDrive();
    expect(bus(d).busRead(0x1800) & 0x05).toBe(0);
    m.memory.writeByte(0x912C, 0xCE);                 // CA2 high: CLK low
    expect(bus(d).busRead(0x1800) & 0x04, 'CLK low').toBe(0x04);
    m.memory.writeByte(0x912C, 0xEC);                 // CB2 high, CA2 low: DATA low, CLK released
    expect(bus(d).busRead(0x1800) & 0x05, 'DATA low, CLK high').toBe(0x01);
    // And the VIC-20 reads back its own pull.
    expect(m.memory.readByte(0x911F) & 0x03).toBe(0x01);
    m.destroy();
  });

  it('reads the drive pulling CLK on VIA 1 PA0', () => {
    const { m, d } = withDrive();
    expect(m.memory.readByte(0x911F) & 0x01).toBe(0x01);
    bus(d).busWrite(0x1802, 0x1A);                    // DATA OUT, CLK OUT, ATNA outputs
    bus(d).busWrite(0x1800, 0x08);                    // CLK OUT
    expect(m.memory.readByte(0x911F) & 0x01, 'CLK in low').toBe(0);
    m.destroy();
  });

  it('leaves the lines high with no drive plugged in', () => {
    const m = machine(firmware());
    m.memory.writeByte(0x9113, 0x80);
    m.memory.writeByte(0x911F, 0x80);
    expect(m.memory.readByte(0x911F) & 0x03).toBe(0x03);
    m.destroy();
  });
});

describe('VIC-20 disks', () => {
  it('fits the drives the Drives pane sets up, and none with the drive unplugged', () => {
    const m = machine(firmware());
    const view = (drive: boolean) => ({
      get: <T>(key: string, fallback: T): T => (
        key === 'vic20-drive' ? drive : key === 'drive-models:vic20' ? ['1541', '1581'] : fallback) as T,
    });
    const roms = m.prepare(view(true));
    expect(m.drives.map(d => d.model)).toEqual(['1541', '1581']);
    expect(roms.map(r => r.cacheKey).sort(), 'the C64\'s DOS ROMs, shared').toEqual(['c64-dos1541-rom', 'c64-dos1581-rom']);
    expect(m.prepare(view(false))).toEqual([]);
    expect(m.drives).toHaveLength(0);
    m.destroy();
  });

  it('puts a dropped .d64 in drive 8', async () => {
    const m = machine(firmware());
    m.iec.fitDrives(['1541']);
    const r = await m.services.media.mount(d64WithFiles([]), 'game.d64');
    expect(r.ok, r.message).toBe(true);
    expect(r.target).toBe('a');
    expect(m.drives[0].loaded).toBe(true);
    expect(m.services.disks.drives[0].mediaName).toBe('game.d64');
    m.destroy();
  });

  it('asks for a 1581 when a .d81 is dropped on a 1541', async () => {
    const m = machine(firmware());
    m.iec.fitDrives(['1541']);
    const r = await m.services.media.mount(new Uint8Array(819200), 'big.d81');
    expect(r.ok).toBe(false);
    expect(r.needsDriveModel).toEqual({ index: 0, model: '1581' });
    m.destroy();
  });

  it('lists each drive in the chip dump', () => {
    const m = machine(firmware());
    m.iec.fitDrives(['1541', '1541']);
    const names = m.services.debug.chips?.().map(c => c.name) ?? [];
    expect(names).toContain('drive');
    expect(names).toContain('drive9');
    m.destroy();
  });
});
