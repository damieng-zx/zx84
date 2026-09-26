/**
 * Intel 8271 FDC core tests.
 *
 * Expectations are derived from the 8271 datasheet as modelled by MAME's
 * `i8271` device, cross-checked against beebjit's `intel_fdc.c` (which mirrors
 * the BBC Model B wiring and the Acorn DFS programming sequence). Disk images
 * are built with the real SSD codec so geometry and byte layout are the same
 * ones DFS 1.20 will see.
 */

import { describe, it, expect } from 'vitest';
import { I8271, I8271Status, I8271Result } from '@/cores/i8271.ts';
import { parseSsd, SSD_TRACK_BYTES, SSD_SECTOR_SIZE } from '@/media/floppy/ssd.ts';

const SECTOR = SSD_SECTOR_SIZE;

/** 80-track single-sided SSD: track 0 s0=0x11, s1=0x22, s3[i]=i; track 1 s0=0xAA. */
function makeSsd(): Uint8Array {
  const data = new Uint8Array(SSD_TRACK_BYTES * 80);
  data.fill(0x11, 0 * SECTOR, 1 * SECTOR); // track 0, sector 0
  data.fill(0x22, 1 * SECTOR, 2 * SECTOR); // track 0, sector 1
  for (let i = 0; i < SECTOR; i++) data[3 * SECTOR + i] = i & 0xff; // track 0, sector 3
  data[SSD_TRACK_BYTES] = 0xaa; // track 1, sector 0
  return data;
}

/** Write a command byte plus its parameters (offset 0 then offset 1 each). */
function send(fdc: I8271, cmd: number, ...params: number[]): void {
  fdc.write(0, cmd);
  for (const p of params) fdc.write(1, p);
}

/** WRITE SPECIAL REGISTER 0x17 — set MODER (0xC1 = no-DMA, DRQ/NMI enabled). */
function setModer(fdc: I8271, value: number): void {
  send(fdc, 0x3a, 0x17, value);
}

/** WRITE SPECIAL REGISTER 0x23 — select drive 0, side 0. */
function selectDrive0Side0(fdc: I8271): void {
  send(fdc, 0x3a, 0x23, 0x48);
}

function makeReadyDrive0(): { fdc: I8271; image: ReturnType<typeof parseSsd> } {
  const fdc = new I8271();
  const image = parseSsd(makeSsd(), false);
  fdc.insertDisk(image, 0);
  setModer(fdc, 0xc1);
  selectDrive0Side0(fdc);
  return { fdc, image };
}

describe('i8271 registers', () => {
  it('reports the selected drive and track 0 in READ DRIVE STATUS without interrupting', () => {
    const irqs: boolean[] = [];
    const fdc = new I8271({ onInterrupt: (a) => irqs.push(a) });

    send(fdc, 0x6c);                     // READ DRIVE STATUS, drive 0 (bit 6 set)
    const drive0 = fdc.read(1);
    expect(drive0 & 0x80).toBe(0x80);    // bit 7 always set
    expect(drive0 & 0x04).toBe(0x04);    // drive 0 selected (== ready)
    expect(drive0 & 0x40).toBe(0);       // drive 1 not selected
    expect(drive0 & 0x02).toBe(0x02);    // head at track 0

    send(fdc, 0xac);                     // READ DRIVE STATUS, drive 1 (bit 7 set)
    const drive1 = fdc.read(1);
    expect(drive1 & 0x40).toBe(0x40);
    expect(drive1 & 0x04).toBe(0);

    // A simple status command must NOT pull the interrupt/NMI line.
    expect(irqs).not.toContain(true);
  });

  it('stores the PCN and returns it from READ SPECIAL REGISTER', () => {
    const { fdc } = makeReadyDrive0();
    send(fdc, 0x29, 0x07); // SEEK (drive 0) to track 7
    expect(fdc.read(1)).toBe(I8271Result.NONE);

    send(fdc, 0x3d, 0x12); // READ SPECIAL REGISTER: PCN drive 0
    expect(fdc.read(1)).toBe(0x07);
  });

  it('leaves the chip idle with no result after SPECIFY', () => {
    const fdc = new I8271();
    send(fdc, 0x35, 0x0d, 0x10, 0x20, 0x30); // step rate/settle/load block
    const status = fdc.read(0);
    expect(status & I8271Status.BSY).toBe(0);
    expect(status & I8271Status.RF).toBe(0);
    expect(status & I8271Status.CF).toBe(0);
  });
});

describe('i8271 read/write', () => {
  it('reads a 256-byte sector via READ DATA SINGLE and ends with result 0', () => {
    const { fdc } = makeReadyDrive0();

    // READ DATA SINGLE (0x12) takes cylinder + sector. The trailing 0x21 is
    // written while EXEC is already running and must be ignored (the sector's
    // own size code N=1 gives the 256-byte length).
    send(fdc, 0x12, 0x00, 0x03, 0x21);
    expect(fdc.read(0) & I8271Status.BSY).toBe(I8271Status.BSY);
    expect(fdc.read(0) & I8271Status.DRQ).toBe(I8271Status.DRQ);

    const got: number[] = [];
    for (let i = 0; i < SECTOR; i++) {
      expect(fdc.read(0) & I8271Status.DRQ).toBe(I8271Status.DRQ);
      got.push(fdc.readData());
    }
    expect(got[0]).toBe(0);
    expect(got[1]).toBe(1);
    expect(got[255]).toBe(0xff);
    expect(fdc.read(1)).toBe(I8271Result.NONE);
  });

  it('reads consecutive sectors for READ DATA MULTI using the count field', () => {
    const { fdc } = makeReadyDrive0();

    send(fdc, 0x13, 0x00, 0x00, 0x22); // size code 1, count 2, from sector 0
    const got: number[] = [];
    for (let i = 0; i < SECTOR * 2; i++) {
      while ((fdc.read(0) & I8271Status.DRQ) === 0) { /* wait for data */ }
      got.push(fdc.readData());
    }
    expect(got[0]).toBe(0x11);      // track 0, sector 0
    expect(got[SECTOR]).toBe(0x22); // track 0, sector 1
    expect(fdc.read(1)).toBe(I8271Result.NONE);
  });

  it('writes bytes into the DskImage and marks the drive dirty', () => {
    const { fdc, image } = makeReadyDrive0();
    expect(fdc.isDirty(0)).toBe(false);

    send(fdc, 0x0a, 0x00, 0x02); // WRITE DATA SINGLE to track 0, sector 2
    for (let i = 0; i < SECTOR; i++) fdc.writeData((0xa0 + i) & 0xff);
    expect(fdc.read(1)).toBe(I8271Result.NONE);

    const sector = image.tracks[0]![0]!.sectors[2];
    expect(sector.data[0]).toBe(0xa0);
    expect(sector.data[1]).toBe(0xa1);
    expect(sector.data[255]).toBe((0xa0 + 255) & 0xff);
    expect(fdc.isDirty(0)).toBe(true);

    fdc.clearDirty(0);
    expect(fdc.isDirty(0)).toBe(false);
  });

  it('returns NOT FOUND for a sector number the track does not contain', () => {
    const { fdc } = makeReadyDrive0();
    send(fdc, 0x12, 0x00, 0x63); // sector 99 does not exist
    expect(fdc.read(1)).toBe(I8271Result.NF);
  });

  it('returns NOT READY when the drive has no disk', () => {
    const fdc = new I8271();
    send(fdc, 0x12, 0x00, 0x03);
    expect(fdc.read(1)).toBe(I8271Result.NR);
  });

  it('refuses to write to a write-protected drive', () => {
    const { fdc, image } = makeReadyDrive0();
    fdc.writeProtect[0] = true;
    const before = image.tracks[0]![0]!.sectors[2].data[0];

    send(fdc, 0x0a, 0x00, 0x02);
    expect(fdc.read(1)).toBe(I8271Result.WP);
    expect(fdc.isDirty(0)).toBe(false);
    expect(image.tracks[0]![0]!.sectors[2].data[0]).toBe(before);
  });
});

describe('i8271 interrupt', () => {
  it('asserts on command completion and clears when the result is read', () => {
    const events: boolean[] = [];
    const fdc = new I8271({ onInterrupt: a => events.push(a) });
    fdc.insertDisk(parseSsd(makeSsd(), false), 0);

    send(fdc, 0x29, 0x05); // SEEK completes and raises the interrupt
    expect(events.at(-1)).toBe(true);

    fdc.read(1); // reading the result releases it
    expect(events.at(-1)).toBe(false);
  });

  it('drives the interrupt from DRQ while no-DMA mode is selected', () => {
    const events: boolean[] = [];
    const fdc = new I8271({ onInterrupt: a => events.push(a) });
    fdc.insertDisk(parseSsd(makeSsd(), false), 0);
    setModer(fdc, 0xc1);
    selectDrive0Side0(fdc);

    send(fdc, 0x12, 0x00, 0x03);
    expect(events.at(-1)).toBe(true); // first data byte is requested
    fdc.readData();
    expect(events.at(-1)).toBe(true); // next byte is requested
  });
});

describe('i8271 format', () => {
  it('erases every sector of the addressed track to 0xE5', () => {
    const { fdc, image } = makeReadyDrive0();
    const track = image.tracks[0]![0]!;
    // FORMAT TRACK: track, GAP3, size/count, GAP5, GAP1.
    send(fdc, 0x23, 0x00, 0x15, 0x2a, 0x00, 0x10);
    expect(fdc.read(1)).toBe(I8271Result.NONE);
    for (const sec of track.sectors) {
      expect(sec.data[0]).toBe(0xe5);
      expect(sec.data[SECTOR - 1]).toBe(0xe5);
    }
    expect(fdc.isDirty(0)).toBe(true);
  });
});
