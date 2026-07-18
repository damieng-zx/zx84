import { describe, expect, it } from 'vitest';
import { parseMdrBlocks } from '@/media/microdrive.ts';

const SECTOR_BYTES = 543;
const RECORD_OFFSET = 15;

function record(name: string, number: number, flags: number, length: number, data: number[] = []): Uint8Array {
  const out = new Uint8Array(SECTOR_BYTES);
  const rec = RECORD_OFFSET;
  out[rec] = flags;
  out[rec + 1] = number;
  out[rec + 2] = length & 0xFF;
  out[rec + 3] = length >> 8;
  for (let i = 0; i < name.length && i < 10; i++) out[rec + 4 + i] = name.charCodeAt(i);
  for (let i = 0; i < data.length && i < 512; i++) out[rec + 15 + i] = data[i];
  return out;
}

describe('parseMdrBlocks', () => {
  it('groups a multi-record BASIC program and reads its declared length and autorun line', () => {
    const header = [0, 0x34, 0x12, 0, 0, 0, 0, 10, 0];
    const first = record('GAME', 0, 0x04, 512, header);
    const second = record('GAME', 1, 0x06, 300);
    const image = new Uint8Array(SECTOR_BYTES * 2 + 1);
    image.set(first, 0);
    image.set(second, SECTOR_BYTES);

    expect(parseMdrBlocks(image)).toEqual([
      { name: 'GAME', type: 'Program', bytes: 0x1234, records: 2, sectors: [0, 1], loadAddress: null, autorunLine: 10 },
    ]);
  });

  it('omits empty records and retains non-Spectrum data as raw block totals', () => {
    const empty = record('', 0, 0, 0);
    const data = record('LEVEL', 2, 0x06, 100);
    const image = new Uint8Array(SECTOR_BYTES * 2);
    image.set(empty, 0);
    image.set(data, SECTOR_BYTES);

    expect(parseMdrBlocks(image)).toEqual([
      { name: 'LEVEL', type: 'Data', bytes: 100, records: 1, sectors: [1], loadAddress: null, autorunLine: null },
    ]);
  });

  it('reads a BYTES file load address from its record-zero header', () => {
    const header = [3, 0x00, 0x1B, 0x00, 0x40, 0, 0, 0xFF, 0xFF];
    const image = record('SCREEN', 0, 0x06, 512, header);

    expect(parseMdrBlocks(image)).toEqual([
      { name: 'SCREEN', type: 'Bytes', bytes: 6912, records: 1, sectors: [0], loadAddress: 16384, autorunLine: null },
    ]);
  });
});
