/**
 * Memotech MEMU `.mfloppy` Type 03 and Type 07 images.
 *
 * The format is a headerless physical-order dump:
 *   40/80 cylinders × 2 sides × 16 sectors × 256 bytes
 * with sectors ordered by cylinder, side, then one-based sector number.
 */

import type { DskImage, DskTrack } from './disk-image.ts';

export const MTX_TYPE03_TRACKS = 40;
export const MTX_TYPE03_SIDES = 2;
export const MTX_TYPE03_SECTORS = 16;
export const MTX_TYPE03_SECTOR_SIZE = 256;
export const MTX_TYPE03_SIZE =
  MTX_TYPE03_TRACKS * MTX_TYPE03_SIDES * MTX_TYPE03_SECTORS * MTX_TYPE03_SECTOR_SIZE;

export const MTX_TYPE07_TRACKS = 80;
export const MTX_TYPE07_SIDES = 2;
export const MTX_TYPE07_SECTORS = 16;
export const MTX_TYPE07_SECTOR_SIZE = 256;
export const MTX_TYPE07_SIZE =
  MTX_TYPE07_TRACKS * MTX_TYPE07_SIDES * MTX_TYPE07_SECTORS * MTX_TYPE07_SECTOR_SIZE;

interface MtxMfloppyGeometry {
  type: '03' | '07';
  tracks: number;
  sides: number;
  sectors: number;
  sectorSize: number;
}

const TYPE03: MtxMfloppyGeometry = {
  type: '03',
  tracks: MTX_TYPE03_TRACKS,
  sides: MTX_TYPE03_SIDES,
  sectors: MTX_TYPE03_SECTORS,
  sectorSize: MTX_TYPE03_SECTOR_SIZE,
};

const TYPE07: MtxMfloppyGeometry = {
  type: '07',
  tracks: MTX_TYPE07_TRACKS,
  sides: MTX_TYPE07_SIDES,
  sectors: MTX_TYPE07_SECTORS,
  sectorSize: MTX_TYPE07_SECTOR_SIZE,
};

function geometryForData(data: Uint8Array): MtxMfloppyGeometry {
  if (data.length === MTX_TYPE03_SIZE) return TYPE03;
  if (data.length === MTX_TYPE07_SIZE) return TYPE07;
  throw new Error(
    `Type 03/07 image must be ${MTX_TYPE03_SIZE} or ${MTX_TYPE07_SIZE} bytes ` +
    `(got ${data.length})`,
  );
}

function geometryForImage(image: DskImage): MtxMfloppyGeometry {
  if (image.numTracks === MTX_TYPE03_TRACKS && image.numSides === MTX_TYPE03_SIDES) {
    return TYPE03;
  }
  if (image.numTracks === MTX_TYPE07_TRACKS && image.numSides === MTX_TYPE07_SIDES) {
    return TYPE07;
  }
  throw new Error('Only double-sided Type 03 and Type 07 images can be saved');
}

function trackAt(
  data: Uint8Array,
  geometry: MtxMfloppyGeometry,
  cylinder: number,
  side: number,
): DskTrack {
  const sectors = [];
  const sectorMap = new Map<number, number>();
  for (let sector = 1; sector <= geometry.sectors; sector++) {
    const offset = (
      (cylinder * geometry.sides + side) * geometry.sectors + sector - 1
    ) * geometry.sectorSize;
    sectorMap.set(sector, sectors.length);
    sectors.push({
      c: cylinder,
      h: side,
      r: sector,
      n: 1,
      st1: 0,
      st2: 0,
      data: data.slice(offset, offset + geometry.sectorSize),
    });
  }
  return { sectors, sectorMap, gap3: 0x10, filler: 0xE5 };
}

export function parseMtxMfloppy(data: Uint8Array): DskImage {
  const geometry = geometryForData(data);

  const tracks: DskImage['tracks'] = [];
  for (let cylinder = 0; cylinder < geometry.tracks; cylinder++) {
    tracks.push([
      trackAt(data, geometry, cylinder, 0),
      trackAt(data, geometry, cylinder, 1),
    ]);
  }

  return {
    format: 'standard',
    numTracks: geometry.tracks,
    numSides: geometry.sides,
    tracks,
    diskFormat: `Memotech Type ${geometry.type}`,
    protection: '',
  };
}

export function serializeMtxMfloppy(image: DskImage): Uint8Array {
  const geometry = geometryForImage(image);
  const out = new Uint8Array(
    geometry.tracks * geometry.sides * geometry.sectors * geometry.sectorSize,
  );
  for (let cylinder = 0; cylinder < geometry.tracks; cylinder++) {
    for (let side = 0; side < geometry.sides; side++) {
      const track = image.tracks[cylinder]?.[side];
      if (!track) throw new Error(`Missing track ${cylinder}, side ${side}`);
      for (let sector = 1; sector <= geometry.sectors; sector++) {
        const index = track.sectorMap.get(sector);
        const data = index === undefined ? null : track.sectors[index]?.data;
        if (!data || data.length !== geometry.sectorSize) {
          throw new Error(`Missing or invalid sector ${cylinder}/${side}/${sector}`);
        }
        const offset = (
          (cylinder * geometry.sides + side) * geometry.sectors + sector - 1
        ) * geometry.sectorSize;
        out.set(data, offset);
      }
    }
  }
  return out;
}
