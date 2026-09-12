/**
 * PCW bootstrap tests.
 *
 * The checksum rule is the hardware's own, quoted from Jacob Nevins' account of
 * the boot sequence: "Sum 512 bytes F000..F1FF" and the "sum should be 0FFh".
 * A disc that fails it is refused, as on real hardware, which "complains"
 * rather than executing the sector.
 */

import { describe, expect, it } from 'vitest';
import type { DskImage, DskSector, DskTrack } from '@/media/floppy/disk-image.ts';
import { bootChecksumValid, loadBootSector } from '@/machines/pcw/bootstrap.ts';

/** A 512-byte sector whose bytes sum to &FF, as a system disc's must. */
function validSector(): Uint8Array {
  const data = new Uint8Array(512);
  data[0] = 0xC3;        // the boot code's own first bytes are irrelevant here
  data[1] = 0x10;
  data[2] = 0xF0;
  // Sum so far is 0xC3 + 0x10 + 0xF0 = 0x1C3, i.e. 0xC3 in eight bits.
  // Add 0x3C to land on 0xFF.
  data[511] = 0x3C;
  return data;
}

function diskWith(sector: Uint8Array | null, record = 1): DskImage {
  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();
  if (sector) {
    sectors.push({ c: 0, h: 0, r: record, n: 2, st1: 0, st2: 0, data: sector });
    sectorMap.set(record, 0);
  }
  const track: DskTrack = { sectors, sectorMap, gap3: 82, filler: 0xE5 };
  return {
    format: 'standard',
    numTracks: 40,
    numSides: 1,
    tracks: [[track]],
    diskFormat: 'PCW',
    protection: '',
  };
}

describe('boot sector checksum', () => {
  it('accepts a sector whose bytes sum to &FF', () => {
    const data = validSector();
    let sum = 0;
    for (const b of data) sum = (sum + b) & 0xFF;
    expect(sum).toBe(0xFF);          // the test's own premise, verified
    expect(bootChecksumValid(data)).toBe(true);
  });

  it('rejects a sector one byte away from correct', () => {
    const data = validSector();
    data[511] = (data[511] + 1) & 0xFF;
    expect(bootChecksumValid(data)).toBe(false);
  });

  it('rejects an erased sector', () => {
    // A freshly formatted data disc is filled with &E5: 512 * 0xE5 mod 256 is
    // 0 (512 is a multiple of 256), not 0xFF.
    expect(bootChecksumValid(new Uint8Array(512).fill(0xE5))).toBe(false);
    expect(bootChecksumValid(new Uint8Array(512))).toBe(false);
  });
});

describe('locating the boot sector', () => {
  it('reads cylinder 0, head 0, sector 1', () => {
    const result = loadBootSector(diskWith(validSector()));
    expect(result.ok).toBe(true);
  });

  it('reports no disc, an unreadable track and a bad checksum separately', () => {
    expect(loadBootSector(null)).toEqual({ ok: false, reason: 'no-disc' });
    // A disc formatted with CP/M data-disc sector numbering (records from 65)
    // has no sector 1 on track 0.
    expect(loadBootSector(diskWith(validSector(), 65)))
      .toEqual({ ok: false, reason: 'unreadable' });
    expect(loadBootSector(diskWith(new Uint8Array(512))))
      .toEqual({ ok: false, reason: 'checksum' });
  });
});
