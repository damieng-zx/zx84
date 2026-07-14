import { describe, it, expect } from 'vitest';
import { WD1793 } from '@/cores/wd1793.ts';
import type { DskImage, DskTrack, DskSector } from '@/floppy/disk-image.ts';

const ST_BUSY = 0x01;
const ST_BIT7 = 0x80; // NOT READY on the 1793

const CMD_RESTORE = 0x00;
const CMD_READ    = 0x80;
const CMD_WRITETRACK = 0xF0;

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
    const wd = new WD1793();
    wd.selectDrive(0);
    wd.writeCommand(CMD_RESTORE);
    expect(wd.readStatus() & ST_BIT7).toBe(ST_BIT7); // not ready
  });

  it('clears bit 7 when a disk is present (drive ready)', () => {
    const wd = new WD1793();
    wd.insertDisk(trdImage(), 0);
    wd.selectDrive(0);
    wd.writeCommand(CMD_RESTORE);
    expect(wd.readStatus() & ST_BIT7).toBe(0); // ready
  });
});

describe('WD1793 INTRQ / DRQ lines', () => {
  it('INTRQ set (command complete) and DRQ clear after a Type I command', () => {
    const wd = new WD1793();
    wd.insertDisk(trdImage(), 0);
    wd.selectDrive(0);
    wd.writeCommand(CMD_RESTORE); // Type I completes instantly → not busy
    expect(wd.intrq).toBe(true);
    expect(wd.drq).toBe(false);
  });

  it('INTRQ clear (busy) and DRQ set during a Type II read transfer', () => {
    const wd = new WD1793();
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
    const wd = new WD1793();
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
