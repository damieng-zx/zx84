import { describe, it, expect, beforeEach } from 'vitest';
import { WD1772 } from '@/cores/wd1772.ts';
import type { DskImage, DskTrack, DskSector } from '@/plus3/dsk.ts';

// ── WD1772 status bits (mirror the constants in wd1772.ts) ───────────────
const ST_BUSY      = 0x01;
const ST_DRQ       = 0x02;
const ST_TRACK0    = 0x04;
const ST_RNF       = 0x10;
const ST_WRITEPROT = 0x40;
const ST_MOTORON   = 0x80;

// ── Commands ─────────────────────────────────────────────────────────────
const CMD_RESTORE = 0x00;
const CMD_SEEK    = 0x10;
const CMD_READ    = 0x80;
const CMD_WRITE   = 0xA0;

function sector(c: number, h: number, r: number, fill: number): DskSector {
  const data = new Uint8Array(512);
  data.fill(fill);
  return { c, h, r, n: 2, st1: 0, st2: 0, data };
}

/** One-track, single-sided image with sectors 1 and 2 on cylinder 0. */
function makeImage(): DskImage {
  const sectors = [sector(0, 0, 1, 0xAB), sector(0, 0, 2, 0xCD)];
  const sectorMap = new Map<number, number>();
  sectors.forEach((s, i) => sectorMap.set(s.r, i));
  const track: DskTrack = { sectors, sectorMap, gap3: 82, filler: 0xE5 };
  return { format: 'standard', numTracks: 1, numSides: 1, tracks: [[track]], diskFormat: 'MGT +D', protection: '' };
}

describe('WD1772 Type I (Restore/Seek)', () => {
  let wd: WD1772;
  beforeEach(() => { wd = new WD1772(); });

  it('SEEK loads the data register value into the track register', () => {
    wd.writeData(40);          // desired track in the data register
    wd.writeCommand(CMD_SEEK);
    expect(wd.trackReg).toBe(40);
    expect(wd.getUnitTrack(0)).toBe(40);
    expect(wd.readStatus() & ST_TRACK0).toBe(0); // not over track 0
  });

  it('RESTORE returns the head to track 0 and sets the TRACK0 flag', () => {
    wd.writeData(10);
    wd.writeCommand(CMD_SEEK);  // move away from 0 first
    expect(wd.trackReg).toBe(10);
    wd.writeCommand(CMD_RESTORE);
    expect(wd.trackReg).toBe(0);
    expect(wd.getUnitTrack(0)).toBe(0);
    expect(wd.readStatus() & ST_TRACK0).toBeTruthy();
  });

  it('SEEK clamps beyond the outermost track (79)', () => {
    wd.writeData(200);
    wd.writeCommand(CMD_SEEK);
    expect(wd.getUnitTrack(0)).toBe(79);
  });
});

describe('WD1772 READ SECTOR', () => {
  let wd: WD1772;
  beforeEach(() => {
    wd = new WD1772();
    wd.insertDisk(makeImage(), 0);
    wd.selectDrive(0);
    wd.setSide(0);
  });

  it('streams the sector bytes and clears BUSY at the end', () => {
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_READ);
    const s = wd.readStatus();
    expect(s & ST_BUSY).toBeTruthy();
    expect(s & ST_DRQ).toBeTruthy();
    for (let i = 0; i < 512; i++) expect(wd.readData()).toBe(0xAB);
    expect(wd.readStatus() & ST_BUSY).toBe(0);
    expect(wd.readStatus() & ST_MOTORON).toBeTruthy();
  });

  it('reports RECORD NOT FOUND for a missing sector', () => {
    wd.writeSectorReg(99);
    wd.writeCommand(CMD_READ);
    expect(wd.readStatus() & ST_RNF).toBeTruthy();
    expect(wd.readStatus() & ST_BUSY).toBe(0);
  });

  it('reports RECORD NOT FOUND when no disk is present', () => {
    const empty = new WD1772();
    empty.writeSectorReg(1);
    empty.writeCommand(CMD_READ);
    expect(empty.readStatus() & ST_RNF).toBeTruthy();
  });
});

describe('WD1772 WRITE SECTOR', () => {
  let wd: WD1772;
  let img: DskImage;
  beforeEach(() => {
    wd = new WD1772();
    img = makeImage();
    wd.insertDisk(img, 0);
    wd.selectDrive(0);
    wd.setSide(0);
  });

  it('writes the streamed bytes into the image sector', () => {
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_WRITE);
    expect(wd.readStatus() & ST_DRQ).toBeTruthy();
    for (let i = 0; i < 512; i++) wd.writeData(i & 0xFF);
    const data = img.tracks[0]![0]!.sectors[0].data;
    expect(data[0]).toBe(0);
    expect(data[255]).toBe(255);
    expect(data[511]).toBe(511 & 0xFF);
    expect(wd.readStatus() & ST_BUSY).toBe(0);
  });

  it('refuses to write a write-protected disk and leaves data intact', () => {
    wd.writeProtect[0] = true;
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_WRITE);
    expect(wd.readStatus() & ST_WRITEPROT).toBeTruthy();
    expect(wd.readStatus() & ST_BUSY).toBe(0);
    // Original fill untouched.
    expect(img.tracks[0]![0]!.sectors[0].data.every(b => b === 0xAB)).toBe(true);
  });
});

describe('WD1772 INDEX pulse (Type I status bit 1)', () => {
  // G+DOS proves a disk is spinning by watching status bit 1 transition 0→1
  // after a Type I / Force Interrupt command. Without the pulse it reports
  // "CHECK DISC". (Regression test for that bug.)
  it('toggles bit 1 across repeated status reads when a disk is present', () => {
    const wd = new WD1772();
    wd.insertDisk(makeImage(), 0);
    wd.selectDrive(0);
    wd.writeCommand(CMD_RESTORE); // Type I → motor on
    let sawSet = false, sawClear = false;
    for (let i = 0; i < 64; i++) {
      if (wd.readStatus() & 0x02) sawSet = true; else sawClear = true;
    }
    expect(sawSet).toBe(true);   // index pulse appears
    expect(sawClear).toBe(true); // and clears — i.e. a real 0→1 edge exists
  });

  it('also pulses after a FORCE INTERRUPT (0xD0), which G+DOS issues first', () => {
    const wd = new WD1772();
    wd.insertDisk(makeImage(), 0);
    wd.selectDrive(0);
    wd.writeCommand(0xD0); // Force Interrupt → Type I status
    let sawSet = false, sawClear = false;
    for (let i = 0; i < 64; i++) {
      if (wd.readStatus() & 0x02) sawSet = true; else sawClear = true;
    }
    expect(sawSet).toBe(true);
    expect(sawClear).toBe(true);
  });

  it('never sets the index bit when the drive is empty (so CHECK DISC is correct then)', () => {
    const wd = new WD1772();
    wd.selectDrive(0);
    wd.writeCommand(CMD_RESTORE);
    for (let i = 0; i < 64; i++) expect(wd.readStatus() & 0x02).toBe(0);
  });

  it('does not inject the index pulse during a Type II read (bit 1 = DRQ)', () => {
    const wd = new WD1772();
    wd.insertDisk(makeImage(), 0);
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_READ); // Type II → bit 1 is DRQ, must stay set, not toggle
    expect(wd.readStatus() & 0x02).toBeTruthy();
    expect(wd.readStatus() & 0x02).toBeTruthy();
  });
});

describe('WD1772 drive/side selection', () => {
  it('reads from the side selected via the control register', () => {
    const wd = new WD1772();
    // Two-sided image: side 0 sector filled 0x11, side 1 filled 0x22.
    const mk = (h: number, fill: number): DskTrack => {
      const s = [sector(0, h, 1, fill)];
      const m = new Map<number, number>([[1, 0]]);
      return { sectors: s, sectorMap: m, gap3: 82, filler: 0xE5 };
    };
    const img: DskImage = {
      format: 'standard', numTracks: 1, numSides: 2,
      tracks: [[mk(0, 0x11), mk(1, 0x22)]], diskFormat: 'MGT +D', protection: '',
    };
    wd.insertDisk(img, 0);
    wd.selectDrive(0);
    wd.setSide(1);
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_READ);
    expect(wd.readData()).toBe(0x22);
  });
});
