/**
 * Unconnected drive select lines on the WD179x.
 *
 * Datasheet behaviour: RESTORE steps the head out until the drive's TR00 input
 * asserts; with no drive on the select line it never does, so after 255 pulses
 * the command ends with the seek-error bit (status bit 4) set and TR00 (bit 2)
 * clear. A drive that is there reports TR00 and no error. On the 1793 the
 * READY input is the drive's, so an absent drive reads NOT READY (bit 7) even
 * though the host has put an image in its slot.
 */

import { describe, it, expect } from 'vitest';
import { WD179x } from '@/cores/wd179x.ts';
import type { DskImage, DskSector, DskTrack } from '@/media/floppy/disk-image.ts';

const ST_TRACK0 = 0x04;
const ST_SEEKERR = 0x10;
const ST_NOT_READY = 0x80;
const CMD_RESTORE = 0x00;

function image(): DskImage {
  const sectors: DskSector[] = [{ c: 0, h: 0, r: 1, n: 1, st1: 0, st2: 0, data: new Uint8Array(256) }];
  const track: DskTrack = { sectors, sectorMap: new Map([[1, 0]]), gap3: 0x2A, filler: 0 };
  return { format: 'standard', numTracks: 1, numSides: 1, tracks: [[track]], diskFormat: 'TR-DOS', protection: '' };
}

function restore(wd: WD179x, unit: number): number {
  wd.selectDrive(unit);
  wd.writeCommand(CMD_RESTORE);
  return wd.readStatus();
}

describe('WD179x connected drive lines', () => {
  it('reports TR00 and no seek error for a connected drive', () => {
    const wd = new WD179x({ statusBit7: 'not-ready', formatSectorsPerTrack: 16 });
    wd.insertDisk(image(), 1);
    const status = restore(wd, 1);
    expect(status & ST_TRACK0).toBe(ST_TRACK0);
    expect(status & ST_SEEKERR).toBe(0);
    expect(status & ST_NOT_READY).toBe(0);
  });

  it('ends RESTORE on an unconnected drive in a seek error with TR00 clear', () => {
    const wd = new WD179x({ statusBit7: 'not-ready', formatSectorsPerTrack: 16 });
    wd.connected[1] = false;
    const status = restore(wd, 1);
    expect(status & ST_TRACK0).toBe(0);
    expect(status & ST_SEEKERR).toBe(ST_SEEKERR);
  });

  it('keeps an unconnected drive not-ready on the 1793 even with an image in its slot', () => {
    const wd = new WD179x({ statusBit7: 'not-ready', formatSectorsPerTrack: 16 });
    wd.insertDisk(image(), 1);
    wd.connected[1] = false;
    expect(restore(wd, 1) & ST_NOT_READY).toBe(ST_NOT_READY);
  });

  it('leaves the other drives alone', () => {
    const wd = new WD179x({ statusBit7: 'not-ready', formatSectorsPerTrack: 16 });
    wd.insertDisk(image(), 0);
    wd.connected[1] = false;
    const status = restore(wd, 0);
    expect(status & ST_TRACK0).toBe(ST_TRACK0);
    expect(status & ST_SEEKERR).toBe(0);
  });
});
