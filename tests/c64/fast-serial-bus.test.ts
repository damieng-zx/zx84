/**
 * The C128's fast serial (burst) bus: the computer's CIA 1 and a 1571's CIA
 * wired SP to SP and CNT to CNT. Whichever end its direction pin makes the
 * sender shifts a byte out (timer A clocks it, most significant bit first);
 * the other end shifts it in on the CNT edges and raises its SP interrupt
 * after eight. Judged against the 6526 data sheet's description of the
 * shift register, with a real `Drive1571` for its CIA and direction pin (no
 * DOS ROM: only the pins matter here).
 */

import { describe, it, expect } from 'vitest';
import { Mos6526 } from '@/cores/mos6526.ts';
import { CbmSerialBus } from '@/machines/shared/cbm/serial-bus.ts';
import type { Drive1571 } from '@/machines/shared/cbm/drive/drive-1571.ts';

const SP = 0x08;
const HOST_HZ = 1_000_000;

/** Timer A underflowing every `period` clocks, set to send (CRA bit 6). */
function startSending(cia: Mos6526, period: number): void {
  cia.write(0x4, period - 1);
  cia.write(0x5, 0);
  cia.write(0xE, 0x51);                      // START | LOAD | SPMODE
}

function rig(): { bus: CbmSerialBus; host: Mos6526; drive: Drive1571 } {
  const bus = new CbmSerialBus(() => 0);
  bus.fitDrives(['1571']);
  const host = new Mos6526();
  host.reset();
  bus.attachFastSerial(host, HOST_HZ);
  const drive = bus.drive as Drive1571;
  drive.cia.reset();
  return { bus, host, drive };
}

/** The drive's direction pin (VIA 1 port A bit 1): driven low to listen, high to send. */
function driveSends(drive: Drive1571, sends: boolean): void {
  drive.via1.ddra = 0x02;
  drive.via1.ora = sends ? 0x02 : 0x00;
}

describe('fast serial bus', () => {
  it('delivers a byte the computer sends to a drive that is listening', () => {
    const { bus, host, drive } = rig();
    driveSends(drive, false);
    bus.fastHostTransmits = true;
    startSending(host, 4);
    host.write(0xC, 0x3C);
    host.advanceTo(63);
    expect(drive.cia.icrFlags & SP, 'seven bits are not a byte').toBe(0);
    host.advanceTo(64);
    expect(drive.cia.read(0xC)).toBe(0x3C);
    expect(drive.cia.icrFlags & SP).toBe(SP);
  });

  it('delivers a byte a drive sends to the computer when the computer listens', () => {
    const { host, drive } = rig();
    driveSends(drive, true);                 // fastHostTransmits stays false
    startSending(drive.cia, 4);
    drive.cia.write(0xC, 0x96);
    drive.cia.advanceTo(64);
    expect(host.read(0xC)).toBe(0x96);
    expect(host.icrFlags & SP).toBe(SP);
  });

  it('delivers nothing while the direction pins have both ends sending or the sender is the wrong one', () => {
    const { bus, host, drive } = rig();
    // The computer sends, but the drive's pin says it sends too: no one listens.
    driveSends(drive, true);
    bus.fastHostTransmits = true;
    startSending(host, 4);
    host.write(0xC, 0xFF);
    host.advanceTo(64);
    expect(drive.cia.icrFlags & SP).toBe(0);
    // The computer's pin says listen: a byte its CIA shifts out does not go on the bus.
    const second = rig();
    driveSends(second.drive, false);
    second.bus.fastHostTransmits = false;
    startSending(second.host, 4);
    second.host.write(0xC, 0xFF);
    second.host.advanceTo(64);
    expect(second.drive.cia.icrFlags & SP).toBe(0);
  });

  it('keeps bytes apart: two sent back to back arrive as two', () => {
    const { bus, host, drive } = rig();
    driveSends(drive, false);
    bus.fastHostTransmits = true;
    startSending(host, 4);
    host.write(0xC, 0x12);
    host.advanceTo(20);
    host.write(0xC, 0xE7);                   // queued behind the first
    host.advanceTo(64);
    expect(drive.cia.read(0xC)).toBe(0x12);
    drive.cia.read(0xD);                     // acknowledge
    host.advanceTo(128);
    expect(drive.cia.read(0xC)).toBe(0xE7);
    expect(drive.cia.icrFlags & SP).toBe(SP);
  });

  it('a drive fitted after the computer is attached is wired too', () => {
    const bus = new CbmSerialBus(() => 0);
    const host = new Mos6526();
    host.reset();
    bus.attachFastSerial(host, HOST_HZ);
    bus.fitDrives(['1571']);
    const drive = bus.drive as Drive1571;
    driveSends(drive, true);
    startSending(drive.cia, 4);
    drive.cia.write(0xC, 0x81);
    drive.cia.advanceTo(64);
    expect(host.read(0xC)).toBe(0x81);
  });

  it('a 1541, which has no fast serial port, takes no part', () => {
    const bus = new CbmSerialBus(() => 0);
    bus.fitDrives(['1541']);
    const host = new Mos6526();
    host.reset();
    bus.attachFastSerial(host, HOST_HZ);
    bus.fastHostTransmits = true;
    startSending(host, 4);
    host.write(0xC, 0xFF);
    expect(() => host.advanceTo(64)).not.toThrow();
  });
});
