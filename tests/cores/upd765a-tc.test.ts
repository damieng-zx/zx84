/**
 * uPD765A Terminal Count.
 *
 * TC is an input pin the +3 and CPC leave unconnected but the PCW drives from
 * its gate array (port &F8 commands 5 and 6). Asserting it during the execution
 * phase ends the transfer there and moves the controller to the result phase.
 *
 * The main status register bits used below are the datasheet's: b7 RQM (data
 * register ready), b6 DIO (1 = controller to CPU), b5 EXM (execution phase),
 * b4 CB (controller busy).
 */

import { describe, expect, it } from 'vitest';
import { UPD765A } from '@/cores/upd765a.ts';
import type { DskImage, DskSector, DskTrack } from '@/media/floppy/disk-image.ts';

const MSR_EXM = 0x20;
const MSR_DIO = 0x40;

/** One track of `count` 512-byte sectors, each filled with its own number. */
function disk(count = 9): DskImage {
  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();
  for (let r = 1; r <= count; r++) {
    sectors.push({
      c: 0, h: 0, r, n: 2, st1: 0, st2: 0,
      data: new Uint8Array(512).fill(r),
    });
    sectorMap.set(r, r - 1);
  }
  const track: DskTrack = { sectors, sectorMap, gap3: 82, filler: 0xE5 };
  return {
    format: 'standard', numTracks: 1, numSides: 1,
    tracks: [[track]], diskFormat: 'PCW', protection: '',
  };
}

/** Issue READ DATA for sectors R..EOT on cylinder 0, head 0. */
function startRead(fdc: UPD765A, r: number, eot: number): void {
  for (const b of [0x46, 0x00, 0x00, 0x00, r, 0x02, eot, 0x2A, 0xFF]) {
    fdc.writeData(b);
  }
}

describe('uPD765A terminal count', () => {
  it('ends a multi-sector read where TC is asserted', () => {
    const fdc = new UPD765A();
    fdc.insertDisk(disk(), 0);
    startRead(fdc, 1, 9);

    // Read the first sector out in full; without TC the controller would carry
    // straight on into sector 2.
    for (let i = 0; i < 512; i++) expect(fdc.readData()).toBe(1);
    expect(fdc.readStatus() & MSR_EXM).toBe(MSR_EXM);
    expect(fdc.readData()).toBe(2);            // sector 2 has begun

    fdc.setTerminalCount(true);
    // Execution is over and the result bytes are waiting.
    expect(fdc.readStatus() & MSR_EXM).toBe(0);
    expect(fdc.readStatus() & MSR_DIO).toBe(MSR_DIO);

    // Seven result bytes: ST0, ST1, ST2, C, H, R, N.
    const result = [];
    for (let i = 0; i < 7; i++) result.push(fdc.readData());
    expect(result[3]).toBe(0);                 // C — still cylinder 0
    expect(result[5]).toBe(2);                 // R — stopped in sector 2
    expect(result[6]).toBe(2);                 // N — 512-byte sectors
  });

  it('only acts on a rising edge, and only during execution', () => {
    const fdc = new UPD765A();
    fdc.insertDisk(disk(), 0);

    // Idle: TC is inert, no phantom result phase.
    fdc.setTerminalCount(true);
    fdc.setTerminalCount(false);
    expect(fdc.readStatus() & (MSR_EXM | MSR_DIO)).toBe(0);

    startRead(fdc, 1, 9);
    fdc.readData();
    // TC is already low; asserting it again is the edge that counts.
    fdc.setTerminalCount(true);
    expect(fdc.readStatus() & MSR_EXM).toBe(0);
    // A second assert with no intervening clear must not disturb the result.
    const st0 = fdc.readData();
    fdc.setTerminalCount(true);
    expect(fdc.readData()).toBe(0);            // ST1 — still the same result
    // TC is the datasheet's normal way to end a transfer, so the interrupt
    // code in ST0 b7-b6 is 00 (normal termination) — not the abnormal 01 that
    // running off the end of the track would give.
    expect(st0 & 0xC0).toBe(0x00);
  });

  it('turns the last sector of a track into a normal termination', () => {
    // A machine that drives TC asserts it just AFTER the last data byte (the
    // PCW's BIOS does), by which time this core has already latched the
    // End-of-Cylinder result. Hardware sets EN only if it actually tries the
    // sector past the last one, which the TC prevents — so the result the CPU
    // then reads must be a normal termination.
    const fdc = new UPD765A();
    fdc.insertDisk(disk(9), 0);
    startRead(fdc, 9, 9);                      // read the final sector only
    for (let i = 0; i < 512; i++) fdc.readData();
    fdc.setTerminalCount(true);

    const result = [];
    for (let i = 0; i < 7; i++) result.push(fdc.readData());
    expect(result[0] & 0xC0).toBe(0x00);       // ST0 IC = normal
    expect(result[1] & 0x80).toBe(0x00);       // ST1 EN clear
    // The CHRN identifies the sector actually transferred, with no cylinder
    // rollover: the transfer stopped, it did not run on. (Datasheet wording on
    // whether R is reported incremented after a TC is ambiguous; nothing
    // observed depends on it, and the sector actually read is the useful
    // answer. The status bits above are what software checks.)
    expect(result[3]).toBe(0);                 // C
    expect(result[5]).toBe(9);                 // R
  });

  it('leaves a genuine End-of-Cylinder alone when TC never arrives', () => {
    // The +3 and CPC never drive TC, and several copy protections check for
    // exactly ST0=0x40 / ST1=0x80 after running off the end of a track.
    const fdc = new UPD765A();
    fdc.insertDisk(disk(9), 0);
    startRead(fdc, 9, 9);
    for (let i = 0; i < 512; i++) fdc.readData();

    const result = [];
    for (let i = 0; i < 7; i++) result.push(fdc.readData());
    expect(result[0]).toBe(0x40);
    expect(result[1]).toBe(0x80);
  });

  it('does not rewrite a result the CPU has already started reading', () => {
    const fdc = new UPD765A();
    fdc.insertDisk(disk(9), 0);
    startRead(fdc, 9, 9);
    for (let i = 0; i < 512; i++) fdc.readData();
    expect(fdc.readData()).toBe(0x40);         // ST0 taken before TC
    fdc.setTerminalCount(true);
    expect(fdc.readData()).toBe(0x80);         // ST1 still End-of-Cylinder
  });

  it('never turns a failed read into a successful one', () => {
    // Only an End-of-Cylinder-and-nothing-else result may be rewritten. A CRC
    // error must survive TC, or protections would start passing on bad data.
    const fdc = new UPD765A();
    const image = disk(9);
    image.tracks[0][0]!.sectors[8].st1 = 0x20;  // data CRC error on sector 9
    fdc.insertDisk(image, 0);
    startRead(fdc, 9, 9);
    for (let i = 0; i < 512; i++) fdc.readData();
    fdc.setTerminalCount(true);

    const result = [];
    for (let i = 0; i < 7; i++) result.push(fdc.readData());
    expect(result[0] & 0x40).toBe(0x40);        // still abnormal
    expect(result[1] & 0x20).toBe(0x20);        // still a CRC error
  });

  it('is cleared by reset', () => {
    const fdc = new UPD765A();
    fdc.insertDisk(disk(), 0);
    fdc.setTerminalCount(true);
    fdc.reset();
    // With TC latched high, a fresh read would terminate on its first byte.
    startRead(fdc, 1, 9);
    fdc.setTerminalCount(true);
    expect(fdc.readStatus() & MSR_DIO).toBe(MSR_DIO);
  });
});
