/**
 * uPD765A INT line.
 *
 * The +3 and the CPC poll the main status register and never look at INT, so
 * nothing here changes for them. The PCW is wired the other way round: the gate
 * array routes INT to /NMI or /INT (port &F8 commands 2-4) and the BIOS waits
 * on it, which makes two things observable that a polling machine cannot see.
 *
 *  - **Non-DMA mode.** Specify's ND bit says the CPU will move the data itself,
 *    and the controller then asks for every byte of the execution phase on INT.
 *    The PCW's sector transfers are driven from that, in the NMI handler.
 *  - **Response time.** Commands complete in zero emulated time here, so INT
 *    can rise in the handful of T-states between a driver writing the last
 *    parameter byte and arming the wait it expects to be woken from. Real
 *    hardware cannot; `intResponseTicks` stops this one doing so either.
 */

import { describe, expect, it } from 'vitest';
import { UPD765A } from '@/cores/upd765a.ts';
import type { DskImage, DskSector, DskTrack } from '@/media/floppy/disk-image.ts';

/** One track of nine 512-byte sectors, each filled with its own number. */
function disk(): DskImage {
  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();
  for (let r = 1; r <= 9; r++) {
    sectors.push({ c: 0, h: 0, r, n: 2, st1: 0, st2: 0, data: new Uint8Array(512).fill(r) });
    sectorMap.set(r, r - 1);
  }
  const track: DskTrack = { sectors, sectorMap, gap3: 82, filler: 0xE5 };
  return {
    format: 'standard', numTracks: 1, numSides: 1,
    tracks: [[track]], diskFormat: 'PCW', protection: '',
  };
}

/** Specify, with ND set or clear. */
function specify(fdc: UPD765A, nonDma: boolean): void {
  fdc.writeData(0x03);
  fdc.writeData(0xAF);
  fdc.writeData(nonDma ? 0x03 : 0x02);
}

/** READ DATA, cylinder 0 head 0, sectors 1..9. */
function startRead(fdc: UPD765A): void {
  for (const b of [0x46, 0x00, 0x00, 0x00, 0x01, 0x02, 0x09, 0x2A, 0xFF]) fdc.writeData(b);
}

describe('uPD765A INT line', () => {
  it('is low when idle and high once result bytes are waiting', () => {
    const fdc = new UPD765A();
    expect(fdc.interruptLine).toBe(false);
    fdc.writeData(0x04);          // SENSE DRIVE STATUS
    fdc.writeData(0x00);
    expect(fdc.interruptLine).toBe(true);
    fdc.readData();
    expect(fdc.interruptLine).toBe(false);
  });

  it('stays high through a DMA-mode execution phase only at its end', () => {
    const fdc = new UPD765A();
    fdc.insertDisk(disk(), 0);
    specify(fdc, false);
    startRead(fdc);
    expect(fdc.interruptLine).toBe(false);      // DRQ would do this work
    fdc.readData();
    expect(fdc.interruptLine).toBe(false);
    fdc.setTerminalCount(true);                 // into the result phase
    expect(fdc.interruptLine).toBe(true);
  });

  it('asks for execution-phase bytes on INT in non-DMA mode', () => {
    const fdc = new UPD765A();
    fdc.insertDisk(disk(), 0);
    specify(fdc, true);
    startRead(fdc);
    // This is the edge the PCW's NMI handler runs off: without it the handler
    // never runs and the sector is never transferred.
    expect(fdc.interruptLine).toBe(true);
    for (let i = 0; i < 512; i++) fdc.readData();
    expect(fdc.interruptLine).toBe(true);
    fdc.setTerminalCount(true);
    expect(fdc.interruptLine).toBe(true);       // now for the result bytes
  });

  it('forgets ND on reset', () => {
    const fdc = new UPD765A();
    fdc.insertDisk(disk(), 0);
    specify(fdc, true);
    fdc.reset();
    startRead(fdc);
    expect(fdc.interruptLine).toBe(false);
  });
});

describe('uPD765A command response time', () => {
  it('holds INT down for intResponseTicks after a command is accepted', () => {
    const fdc = new UPD765A();
    fdc.intResponseTicks = 3;
    fdc.writeData(0x04);          // SENSE DRIVE STATUS — result ready at once
    fdc.writeData(0x00);
    expect(fdc.interruptLine).toBe(false);
    fdc.tickIntResponse();
    fdc.tickIntResponse();
    expect(fdc.interruptLine).toBe(false);
    fdc.tickIntResponse();
    expect(fdc.interruptLine).toBe(true);
  });

  it('leaves the result bytes readable meanwhile, so polling is unaffected', () => {
    const fdc = new UPD765A();
    fdc.intResponseTicks = 100;
    fdc.writeData(0x07);          // RECALIBRATE
    fdc.writeData(0x00);
    fdc.writeData(0x08);          // SENSE INTERRUPT STATUS
    expect(fdc.readStatus()).toBe(0xD0);        // RQM + DIO + CB: results waiting
    expect(fdc.readData()).toBe(0x20);          // ST0: seek end, unit 0
    expect(fdc.readData()).toBe(0x00);          // PCN
  });

  it('re-arms per command, so one long wait cannot cover the next', () => {
    const fdc = new UPD765A();
    fdc.intResponseTicks = 2;
    fdc.writeData(0x04);
    fdc.writeData(0x00);
    fdc.tickIntResponse();
    fdc.tickIntResponse();
    expect(fdc.interruptLine).toBe(true);
    fdc.readData();

    fdc.writeData(0x04);
    fdc.writeData(0x00);
    expect(fdc.interruptLine).toBe(false);
  });

  it('defaults to answering instantly, which is what a polling machine wants', () => {
    const fdc = new UPD765A();
    fdc.writeData(0x04);
    fdc.writeData(0x00);
    expect(fdc.interruptLine).toBe(true);
  });
});
