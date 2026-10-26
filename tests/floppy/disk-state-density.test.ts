import { describe, it, expect } from 'vitest';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { readDskImage, writeDskImage } from '@/media/floppy/disk-state.ts';
import { WD179x } from '@/cores/wd179x.ts';
import type { DskImage, DskTrack } from '@/media/floppy/disk-image.ts';

// A save state must keep what a controller needs to read a disc in the right
// density: a track's recording (FM vs MFM — the WD1770 and 8271 refuse a track
// in the other density) and, for HFE-backed discs, the FM cell scale of each
// sector's data field. Losing either turns a readable disc unreadable after a
// restore.

function track(encoding?: 'fm' | 'mfm'): DskTrack {
  const data = new Uint8Array(256).fill(0xE5);
  const t: DskTrack = {
    sectors: [{ c: 0, h: 0, r: 0, n: 1, st1: 0, st2: 0, data }],
    sectorMap: new Map([[0, 0]]),
    gap3: 16, filler: 0xE5,
  };
  if (encoding) t.encoding = encoding;
  return t;
}

function image(): DskImage {
  return {
    format: 'extended', numTracks: 3, numSides: 1, diskFormat: '', protection: '',
    tracks: [[track('fm')], [track('mfm')], [track()]],
    bitstream: {
      cells: [[new Uint8Array(8)], [new Uint8Array(8)], [null]],
      layout: [
        [[{ dataBit: 100, len: 256, mark: 0xFB, fm: 2 }]],
        [[{ dataBit: 200, len: 256, mark: 0xF8 }]],
        [null],
      ],
    },
  } as unknown as DskImage;
}

function roundTrip(img: DskImage): DskImage {
  const w = new StateWriter();
  writeDskImage(w, img);
  return readDskImage(new StateReader(w.finish()));
}

describe('disk state keeps recording density', () => {
  it('restores FM, MFM and unspecified track encodings as saved', () => {
    const back = roundTrip(image());
    expect(back.tracks[0][0]?.encoding).toBe('fm');
    expect(back.tracks[1][0]?.encoding).toBe('mfm');
    expect(back.tracks[2][0]?.encoding).toBeUndefined();
  });

  it('restores the FM cell scale of an HFE data field, and its absence on MFM', () => {
    const back = roundTrip(image());
    expect(back.bitstream?.layout[0][0]?.[0].fm).toBe(2);
    expect(back.bitstream?.layout[1][0]?.[0].fm).toBeUndefined();
    expect(back.bitstream?.layout[1][0]?.[0].mark).toBe(0xF8);
  });
});

describe('WD179x state keeps the density input', () => {
  const make = () => new WD179x({ statusBit7: 'motor-on', formatSectorsPerTrack: 10, onInterrupt: () => {} });

  for (const single of [true, false]) {
    it(`restores single density = ${single}`, () => {
      const a = make();
      a.setDensity(single);
      const w = new StateWriter();
      a.saveState(w);
      const b = make();
      b.setDensity(!single);
      b.loadState(new StateReader(w.finish()));
      expect(b.singleDensity).toBe(single);
    });
  }
});
