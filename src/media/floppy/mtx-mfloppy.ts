/**
 * Memotech MEMU `.mfloppy` Type 07 images.
 *
 * The format is a headerless physical-order dump:
 *   80 cylinders × 2 sides × 16 sectors × 256 bytes = 655,360 bytes
 * with sectors ordered by cylinder, side, then one-based sector number.
 */

import type { DskImage, DskTrack } from './disk-image.ts';

export const MTX_TYPE07_TRACKS = 80;
export const MTX_TYPE07_SIDES = 2;
export const MTX_TYPE07_SECTORS = 16;
export const MTX_TYPE07_SECTOR_SIZE = 256;
export const MTX_TYPE07_SIZE =
  MTX_TYPE07_TRACKS * MTX_TYPE07_SIDES * MTX_TYPE07_SECTORS * MTX_TYPE07_SECTOR_SIZE;

function trackAt(data: Uint8Array, cylinder: number, side: number): DskTrack {
  const sectors = [];
  const sectorMap = new Map<number, number>();
  for (let sector = 1; sector <= MTX_TYPE07_SECTORS; sector++) {
    const offset = (
      (cylinder * MTX_TYPE07_SIDES + side) * MTX_TYPE07_SECTORS + sector - 1
    ) * MTX_TYPE07_SECTOR_SIZE;
    sectorMap.set(sector, sectors.length);
    sectors.push({
      c: cylinder,
      h: side,
      r: sector,
      n: 1,
      st1: 0,
      st2: 0,
      data: data.slice(offset, offset + MTX_TYPE07_SECTOR_SIZE),
    });
  }
  return { sectors, sectorMap, gap3: 0x10, filler: 0xE5 };
}

export function parseMtxMfloppy(data: Uint8Array): DskImage {
  if (data.length !== MTX_TYPE07_SIZE) {
    throw new Error(
      `Type 07 image must be ${MTX_TYPE07_SIZE} bytes (got ${data.length})`,
    );
  }

  const tracks: DskImage['tracks'] = [];
  for (let cylinder = 0; cylinder < MTX_TYPE07_TRACKS; cylinder++) {
    tracks.push([
      trackAt(data, cylinder, 0),
      trackAt(data, cylinder, 1),
    ]);
  }

  return {
    format: 'standard',
    numTracks: MTX_TYPE07_TRACKS,
    numSides: MTX_TYPE07_SIDES,
    tracks,
    diskFormat: 'Memotech Type 07',
    protection: '',
  };
}

export function serializeMtxMfloppy(image: DskImage): Uint8Array {
  if (
    image.numTracks !== MTX_TYPE07_TRACKS ||
    image.numSides !== MTX_TYPE07_SIDES
  ) {
    throw new Error('Only 80-track, double-sided Type 07 images can be saved');
  }

  const out = new Uint8Array(MTX_TYPE07_SIZE);
  for (let cylinder = 0; cylinder < MTX_TYPE07_TRACKS; cylinder++) {
    for (let side = 0; side < MTX_TYPE07_SIDES; side++) {
      const track = image.tracks[cylinder]?.[side];
      if (!track) throw new Error(`Missing track ${cylinder}, side ${side}`);
      for (let sector = 1; sector <= MTX_TYPE07_SECTORS; sector++) {
        const index = track.sectorMap.get(sector);
        const data = index === undefined ? null : track.sectors[index]?.data;
        if (!data || data.length !== MTX_TYPE07_SECTOR_SIZE) {
          throw new Error(`Missing or invalid sector ${cylinder}/${side}/${sector}`);
        }
        const offset = (
          (cylinder * MTX_TYPE07_SIDES + side) * MTX_TYPE07_SECTORS + sector - 1
        ) * MTX_TYPE07_SECTOR_SIZE;
        out.set(data, offset);
      }
    }
  }
  return out;
}
