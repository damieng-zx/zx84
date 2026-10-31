/**
 * The disk files EXDOS takes, and the card's single-density select.
 *
 * EXDOS disks are PC-compatible FAT12 volumes of 512-byte sectors numbered from
 * 1. A raw dump is every sector in cylinder-major, head-minor order; its
 * geometry comes from the boot sector's BIOS parameter block (sectors per
 * track at offset 24, heads at 26, total sectors at 19). An MSX `.img` is the
 * same dump after one header byte (1 or 2 sides). Containers (HFE, SCP, CPC
 * DSK) are recognised by their signatures.
 */

import { describe, it, expect } from 'vitest';
import { blankFatImage, parseFatFloppy, serializeFatImage } from '@/media/floppy/fat-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { encodeHFE } from '@/media/floppy/hfe.ts';
import { ExdosCard } from '@/machines/enterprise/exdos.ts';
import { EnterpriseMachine } from '@/machines/enterprise/enterprise-machine.ts';

describe('parseFatFloppy', () => {
  it.each([
    [40, 2, 9], [80, 1, 9], [40, 1, 8], [80, 2, 18],
  ])('lays out a raw %i-track, %i-sided, %i-sector dump by its boot sector', (tracks, sides, spt) => {
    const raw = serializeFatImage(blankFatImage(tracks, sides, spt));
    const img = parseFatFloppy(raw)!;
    expect([img.numTracks, img.numSides, img.tracks[0][0]!.sectors.length]).toEqual([tracks, sides, spt]);
    expect(img.tracks[tracks - 1][sides - 1]!.sectors.map(s => s.r)).toEqual(Array.from({ length: spt }, (_, i) => i + 1));
  });

  it('drops the header byte of an MSX .img', () => {
    const raw = serializeFatImage(blankFatImage(80, 2, 9));
    const withHeader = new Uint8Array(raw.length + 1);
    withHeader[0] = 2;
    withHeader.set(raw, 1);
    const img = parseFatFloppy(withHeader)!;
    expect(img.numTracks).toBe(80);
    expect(img.tracks[0][0]!.sectors[0].data).toEqual(raw.subarray(0, 512));
  });

  it('reads a CPC-style DSK and an HFE by their signatures', () => {
    const blank = blankFatImage(80, 2, 9);
    for (const data of [serializeDSK(blank), encodeHFE(blank)]) {
      const img = parseFatFloppy(data)!;
      expect(img.numTracks).toBe(80);
      expect(img.numSides).toBe(2);
      expect(img.tracks[0][0]!.sectors[0].data).toEqual(blank.tracks[0][0]!.sectors[0].data);
    }
  });

  it('returns null for something that is no disk', () => {
    expect(parseFatFloppy(new Uint8Array(1000))).toBeNull();
  });
});

describe('EXDOS control latch', () => {
  it('drives the WD1770 /DDEN from bit 5 (1 = single density)', () => {
    const card = new ExdosCard();
    card.writeControl(0x21);
    expect(card.fdc.singleDensity).toBe(true);
    card.writeControl(0x01);
    expect(card.fdc.singleDensity).toBe(false);
  });
});

describe('Enterprise disk save', () => {
  function machineWithDisk(): EnterpriseMachine {
    const m = new EnterpriseMachine('ep128', null);
    const view = { get: <T>(key: string, fallback: T): T => (key === 'enterprise-exdos' ? true as unknown as T : fallback) };
    m.prepare(view);
    return m;
  }

  it('saves a plain FAT layout as .img and an HFE-sourced disk as .hfe', () => {
    const m = machineWithDisk();
    m.services.disks.insert('a', blankFatImage(80, 2, 9), 'plain.img');
    expect(m.services.disks.save('a')!.name).toBe('plain.img');
    m.services.disks.insert('b', parseFatFloppy(encodeHFE(blankFatImage(80, 2, 9)))!, 'bits.hfe');
    const saved = m.services.disks.save('b')!;
    expect(saved.name).toBe('bits.hfe');
    expect(String.fromCharCode(...saved.data.subarray(0, 8))).toBe('HXCPICFE');
    m.destroy();
  });

  it('saves a disk a raw dump cannot hold (a deleted-data sector) as .hfe', () => {
    const m = machineWithDisk();
    const img = blankFatImage(80, 2, 9);
    img.tracks[3][1]!.sectors[2].st2 = 0x40;
    m.services.disks.insert('a', img, 'odd.dsk');
    const saved = m.services.disks.save('a')!;
    expect(saved.name).toBe('odd.hfe');
    expect(parseFatFloppy(saved.data)!.tracks[3][1]!.sectors[2].st2).toBe(0x40);
    m.destroy();
  });
});
