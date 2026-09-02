import { describe, it, expect } from 'vitest';
import { WD179x } from '@/cores/wd179x.ts';
import type { DskImage, DskTrack, DskSector } from '@/media/floppy/disk-image.ts';

const ST_BUSY    = 0x01;
const ST_CRCERR  = 0x08;
const ST_RNF     = 0x10;
const ST_RECTYPE = 0x20; // Type II read: record type (deleted-data mark)
const ST_BIT7    = 0x80; // NOT READY on the 1793

const CMD_RESTORE   = 0x00;
const CMD_READ      = 0x80;
const CMD_READ_MULTI = 0x90;
const CMD_WRITE     = 0xA0;
const CMD_WRITETRACK = 0xF0;

function wd1793(): WD179x {
  return new WD179x({ statusBit7: 'not-ready', formatSectorsPerTrack: 16 });
}

/** One-track single-sided TR-DOS-geometry image (16 × 256-byte sectors). */
function trdImage(fill = 0xAB): DskImage {
  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();
  for (let s = 0; s < 16; s++) {
    const data = new Uint8Array(256); data.fill(fill);
    sectors.push({ c: 0, h: 0, r: s + 1, n: 1, st1: 0, st2: 0, data });
    sectorMap.set(s + 1, s);
  }
  const track: DskTrack = { sectors, sectorMap, gap3: 0x2A, filler: 0 };
  return { format: 'standard', numTracks: 1, numSides: 1, tracks: [[track]], diskFormat: 'TR-DOS', protection: '' };
}

describe('WD1793 status bit 7 = NOT READY', () => {
  it('sets bit 7 after a Type I command when no disk is present', () => {
    const wd = wd1793();
    wd.selectDrive(0);
    wd.writeCommand(CMD_RESTORE);
    expect(wd.readStatus() & ST_BIT7).toBe(ST_BIT7); // not ready
  });

  it('clears bit 7 when a disk is present (drive ready)', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0);
    wd.selectDrive(0);
    wd.writeCommand(CMD_RESTORE);
    expect(wd.readStatus() & ST_BIT7).toBe(0); // ready
  });
});

describe('WD1793 INTRQ / DRQ lines', () => {
  it('INTRQ set (command complete) and DRQ clear after a Type I command', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0);
    wd.selectDrive(0);
    wd.writeCommand(CMD_RESTORE); // Type I completes instantly → not busy
    expect(wd.intrq).toBe(true);
    expect(wd.drq).toBe(false);
  });

  it('INTRQ clear (busy) and DRQ set during a Type II read transfer', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0);
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_READ); // BUSY|DRQ until the buffer is drained
    expect(wd.intrq).toBe(false);
    expect(wd.drq).toBe(true);
  });
});

describe('WD1793 WRITE TRACK finalises at 16 sectors', () => {
  it('rebuilds a 16-sector TR-DOS track from the format stream', () => {
    const wd = wd1793();
    const img = trdImage(); // reuse geometry; we overwrite cylinder 0
    wd.insertDisk(img, 0);
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeCommand(CMD_WRITETRACK);

    // Feed 16 sectors: each is an ID field (0xFE, C,H,R,N) then a data field
    // (0xFB + 256 bytes). The parser finalises the track at 16 sectors.
    for (let r = 1; r <= 16; r++) {
      wd.writeData(0xFE);
      wd.writeData(0);      // C
      wd.writeData(0);      // H
      wd.writeData(r);      // R
      wd.writeData(1);      // N (256 bytes)
      wd.writeData(0xFB);   // data address mark
      for (let b = 0; b < 256; b++) wd.writeData(r); // fill with the sector no.
    }

    const track = img.tracks[0]![0]!;
    expect(track.sectors.length).toBe(16);
    expect(track.sectors.map(s => s.r).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    // Each sector's data is its own R value; sector 5's byte 0 is 5.
    const s5 = track.sectors[track.sectorMap.get(5)!];
    expect(s5.data.length).toBe(256);
    expect(s5.data[0]).toBe(5);
    expect(wd.readStatus() & ST_BUSY).toBe(0); // command finished
  });
});

describe('WD1793 Type II status — record type and CRC error', () => {
  function readSector(wd: WD179x, r: number, bytes = 256): number {
    wd.writeSectorReg(r);
    wd.writeCommand(CMD_READ);
    const status = wd.readStatus();
    for (let i = 0; i < bytes; i++) wd.readData();
    return status;
  }

  it('READ SECTOR reports bit 5 (record type) for a sector stored with a deleted-data mark', () => {
    const wd = wd1793();
    const img = trdImage();
    img.tracks[0][0]!.sectors[0].st2 = 0x40; // DDAM
    wd.insertDisk(img, 0);
    wd.selectDrive(0);
    wd.setSide(0);
    const status = readSector(wd, 1);
    expect(status & ST_RECTYPE).toBeTruthy();
    // Completion status (after the buffer drains) still carries the flag.
    expect(wd.readStatus() & ST_RECTYPE).toBeTruthy();
  });

  it('READ SECTOR leaves bit 5 clear for a normal data-mark sector', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0);
    wd.selectDrive(0);
    wd.setSide(0);
    const status = readSector(wd, 1);
    expect(status & ST_RECTYPE).toBe(0);
  });

  it('READ SECTOR reports bit 3 (CRC error) for a sector flagged with a data CRC error', () => {
    const wd = wd1793();
    const img = trdImage();
    img.tracks[0][0]!.sectors[0].st1 = 0x20; // data field CRC error
    wd.insertDisk(img, 0);
    wd.selectDrive(0);
    wd.setSide(0);
    const status = readSector(wd, 1);
    expect(status & ST_CRCERR).toBeTruthy();
  });

  it('a0 (bit 0) on WRITE SECTOR marks the sector with a deleted-data address mark', () => {
    const wd = wd1793();
    const img = trdImage();
    wd.insertDisk(img, 0);
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_WRITE | 0x01); // a0=1 -> deleted-data mark
    for (let i = 0; i < 256; i++) wd.writeData(0xEE);
    expect(img.tracks[0][0]!.sectors[0].st2 & 0x40).toBeTruthy();

    // A subsequent read now reports the record-type bit.
    const status = readSector(wd, 1);
    expect(status & ST_RECTYPE).toBeTruthy();
  });

  it('a0=0 on WRITE SECTOR clears a previously-set deleted-data mark', () => {
    const wd = wd1793();
    const img = trdImage();
    img.tracks[0][0]!.sectors[0].st2 = 0x40; // starts deleted
    wd.insertDisk(img, 0);
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_WRITE); // a0=0 -> normal data mark
    for (let i = 0; i < 256; i++) wd.writeData(0x11);
    expect(img.tracks[0][0]!.sectors[0].st2 & 0x40).toBe(0);
  });
});

describe('WD1793 multi-sector READ termination', () => {
  it('reads through consecutive sectors when each R+1 is found', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0);
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_READ_MULTI);
    // Drain sectors 1..15 (256 bytes each) — each finishRead should chain
    // straight into the next sector's DRQ instead of completing.
    for (let s = 1; s < 15; s++) {
      for (let i = 0; i < 256; i++) wd.readData();
      const status = wd.readStatus();
      expect(status & ST_BUSY).toBeTruthy();
      expect(wd.readSectorReg()).toBe(s + 1);
    }
  });

  it('ends in RECORD NOT FOUND once R+1 is absent (real hardware behaviour)', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0); // sectors 1..16 only
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeSectorReg(16); // last sector on the track
    wd.writeCommand(CMD_READ_MULTI);
    for (let i = 0; i < 256; i++) wd.readData();
    const status = wd.readStatus();
    expect(status & ST_BUSY).toBe(0);
    expect(status & ST_RNF).toBeTruthy();
  });
});

describe('WD1793 Type II ID search — cylinder must match the Track Register', () => {
  // trdImage's sectors are all stored with C=0. The physical head position
  // (headTrack) and the Track Register normally move together, but a STEP
  // without the 'u' flag — or directly poking trackReg, as here — can desync
  // them, which is exactly the technique some protections use.
  it('READ SECTOR fails RNF when the Track Register does not match the ID field', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0);
    wd.selectDrive(0);
    wd.setSide(0);
    wd.trackReg = 5; // desynced from the physical position (still 0)
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_READ);
    expect(wd.readStatus() & ST_RNF).toBeTruthy();
  });

  it('READ SECTOR succeeds when the Track Register matches the ID field', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0); // trackReg defaults to 0, matching every sector's C
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_READ);
    expect(wd.readStatus() & ST_RNF).toBe(0);
  });
});

describe('WD1793 Type II side compare (S/C command bits)', () => {
  const CMD_READ_SIDE0 = 0x82; // C=1 (enable), S=0 -> compare for side 0
  const CMD_READ_SIDE1 = 0x8A; // C=1 (enable), S=1 -> compare for side 1

  it('accepts a sector whose stored side matches the S bit', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0); // sectors stored with h=0
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_READ_SIDE0);
    expect(wd.readStatus() & ST_RNF).toBe(0);
  });

  it('rejects (RNF) a sector whose stored side does not match the S bit', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0); // sectors stored with h=0
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_READ_SIDE1);
    expect(wd.readStatus() & ST_RNF).toBeTruthy();
  });

  it('side compare is off by default (C=0): a stored-side mismatch is not checked', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0);
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeSectorReg(1);
    wd.writeCommand(CMD_READ); // C=0, S=0 — no comparison performed
    expect(wd.readStatus() & ST_RNF).toBe(0);
  });
});

describe('WD1793 Type I verify (V bit)', () => {
  const CMD_SEEK_V = 0x14; // SEEK with V=1 (bit 2)

  it('sets the seek-error bit (shares ST_RNF) when the destination track has no matching ID', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0); // only cylinder 0 exists
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeData(5); // seek target has no track in the image at all
    wd.writeCommand(CMD_SEEK_V);
    expect(wd.readStatus() & ST_RNF).toBeTruthy();
  });

  it('clears the seek-error bit when the destination track\'s ID matches the Track Register', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0);
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeData(0); // the image's only track, ID C=0 matches the post-seek TR=0
    wd.writeCommand(CMD_SEEK_V);
    expect(wd.readStatus() & ST_RNF).toBe(0);
  });

  it('V=0 (default) never checks the ID field, even seeking to a non-existent track', () => {
    const wd = wd1793();
    wd.insertDisk(trdImage(), 0);
    wd.selectDrive(0);
    wd.setSide(0);
    wd.writeData(5);
    wd.writeCommand(0x10); // plain SEEK, V=0
    expect(wd.readStatus() & ST_RNF).toBe(0);
  });
});
