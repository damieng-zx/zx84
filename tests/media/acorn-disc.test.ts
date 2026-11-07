/**
 * Acorn disc routing (BBC Micro, Electron Plus 3): content sniffing of sector
 * dumps and containers, and how a mounted disc is written back out.
 *
 * Expectations come from the on-disc formats: a DFS catalogue is sectors 0-1
 * (sector 1 byte 5 = 8 × file count, bytes 6-7 = boot option and sector count);
 * an old-map ADFS disc has its root directory at sector 2, whose bytes 1-4 are
 * "Hugo".
 */

import { describe, it, expect } from 'vitest';
import { parseAcornDisc, serializeAcornDisc, acornFilingSystem } from '@/media/floppy/acorn-disc.ts';
import { detectAcornRawFormat, hasRegularLayout, sniffDiskContainer } from '@/media/floppy/disk-detect.ts';
import { encodeHFE, parseHFE } from '@/media/floppy/hfe.ts';
import { blankSsd, parseSsd, SSD_TRACK_BYTES } from '@/media/floppy/ssd.ts';
import { blankAdfs, serializeAdfs } from '@/media/floppy/adfs.ts';

/** A DFS disc of `tracks` tracks holding one file "$.GAME" (8 sectors from sector 2). */
function dfsDisc(tracks = 40): Uint8Array {
  const d = new Uint8Array(tracks * SSD_TRACK_BYTES).fill(0xE5);
  d.fill(0, 0, 512);
  d.set([...'DISCNAME'].map(c => c.charCodeAt(0)), 0);
  d.set([...'GAME   $'].map(c => c.charCodeAt(0)), 8);
  d[0x105] = 8;                                   // one file
  d[0x106] = ((tracks * 10) >> 8) | 0x30;         // boot option 3, sector count high bits
  d[0x107] = (tracks * 10) & 0xFF;
  d.set([0x00, 0x19, 0x00, 0x19, 0x00, 0x08, 0x00, 0x02], 0x108);
  return d;
}

/** An ADFS S disc as *FORMAT leaves it: the root directory at sector 2 says "Hugo". */
function adfsDisc(): Uint8Array {
  const d = serializeAdfs(blankAdfs(40, false));
  d.set([0x00, ...'Hugo'].map(c => typeof c === 'number' ? c : c.charCodeAt(0)), 0x200);
  return d;
}

describe('sniffDiskContainer', () => {
  it.each([
    ['HXCPICFE', 'hfe'], ['HXCHFEV3', 'hfe'], ['MV - CPCEMU', 'cpc-dsk'], ['EXTENDED CPC', 'cpc-dsk'],
    ['SCP\x00', 'scp'], ['TD\x00', 'td0'], ['td\x00', 'td0'],
  ] as const)('names %j as %s', (sig, want) => {
    const d = new Uint8Array(512);
    d.set([...sig].map(c => c.charCodeAt(0)));
    expect(sniffDiskContainer(d)).toBe(want);
  });

  it('returns null for a headerless sector dump', () => {
    expect(sniffDiskContainer(dfsDisc())).toBeNull();
  });
});

describe('detectAcornRawFormat', () => {
  it('finds ADFS by the "Hugo" root directory at sector 2', () => {
    expect(detectAcornRawFormat(adfsDisc())).toBe('adfs');
  });

  it('finds DFS by a well-formed catalogue', () => {
    expect(detectAcornRawFormat(dfsDisc())).toBe('dfs');
    // A freshly formatted DFS disc has no files but still declares its size.
    expect(detectAcornRawFormat(serializeSsdBlank())).toBe('dfs');
  });

  it('rejects a catalogue whose file count is not a multiple of eight', () => {
    const d = dfsDisc();
    d[0x105] = 9;
    expect(detectAcornRawFormat(d)).toBeNull();
  });

  it('rejects a catalogue that declares fewer than two sectors (unformatted filler)', () => {
    expect(detectAcornRawFormat(new Uint8Array(SSD_TRACK_BYTES * 40).fill(0xE5))).toBeNull();
  });

  it('rejects unprintable file names', () => {
    const d = dfsDisc();
    d[8] = 0x01;
    expect(detectAcornRawFormat(d)).toBeNull();
  });
});

function serializeSsdBlank(): Uint8Array {
  const img = blankSsd(40, false);
  const out = new Uint8Array(40 * SSD_TRACK_BYTES);
  for (let t = 0; t < 40; t++) for (const s of img.tracks[t][0]!.sectors) out.set(s.data, t * SSD_TRACK_BYTES + s.r * 256);
  return out;
}

describe('parseAcornDisc', () => {
  it('reads a .img or .dsk as ADFS or DFS by its content, not its name', () => {
    expect(parseAcornDisc(adfsDisc(), 'x.img', 'dfs').fs).toBe('adfs');
    expect(parseAcornDisc(dfsDisc(), 'x.dsk', 'adfs').fs).toBe('dfs');
  });

  it('takes the machine\'s filing system for a dump that says neither', () => {
    const blank = new Uint8Array(160 * 1024).fill(0xE5);
    expect(parseAcornDisc(blank, 'x.img', 'adfs').image.tracks[0][0]!.sectors).toHaveLength(16);
    expect(parseAcornDisc(blank, 'x.img', 'dfs').image.tracks[0][0]!.sectors).toHaveLength(10);
  });

  it('takes a .img over 80 single-sided DFS tracks as double-sided', () => {
    const longer = new Uint8Array(80 * SSD_TRACK_BYTES + 256);
    longer.set(dfsDisc(80));
    expect(parseAcornDisc(longer, 'x.img').image.numSides).toBe(2);
    expect(parseAcornDisc(dfsDisc(80), 'x.img').image.numSides).toBe(1);
  });

  it('reads an HFE by its signature whatever the file is called', () => {
    const hfe = encodeHFE(parseSsd(dfsDisc(), false));
    const disc = parseAcornDisc(hfe, 'saved.ssd');
    expect(disc.image.bitstream).toBeDefined();
    expect(disc.fs).toBe('dfs');
    expect(disc.image.tracks[0][0]!.encoding).toBe('fm');
  });

  it('refuses a CPC DSK or Teledisk image', () => {
    const dsk = new Uint8Array(512);
    dsk.set([...'MV - CPC'].map(c => c.charCodeAt(0)));
    expect(() => parseAcornDisc(dsk, 'x.dsk')).toThrow(/not an Acorn disc/);
  });
});

describe('acornFilingSystem', () => {
  it('is DFS for ten 256-byte FM sectors and ADFS for sixteen MFM ones', () => {
    expect(acornFilingSystem(blankSsd(40, false))).toBe('dfs');
    expect(acornFilingSystem(blankAdfs(40, false))).toBe('adfs');
  });

  it('is null for a protection first track (an odd sector count)', () => {
    const img = blankSsd(40, false);
    img.tracks[0][0]!.sectors.pop();
    expect(acornFilingSystem(img)).toBeNull();
  });
});

describe('serializeAcornDisc', () => {
  it('saves a plain DFS layout as .ssd, byte for byte', () => {
    const raw = dfsDisc();
    const out = serializeAcornDisc(parseSsd(raw, false));
    expect(out.ext).toBe('.ssd');
    expect(out.data).toEqual(raw);
  });

  it('saves a plain ADFS layout as an ADFS dump', () => {
    expect(serializeAcornDisc(blankAdfs(80, true)).ext).toBe('.adl');
    expect(serializeAcornDisc(blankAdfs(80, false)).ext).toBe('.adm');
    expect(serializeAcornDisc(blankAdfs(40, false)).ext).toBe('.ads');
  });

  it('saves an HFE-sourced disc as .hfe', () => {
    const img = parseHFE(encodeHFE(parseSsd(dfsDisc(), false)));
    const out = serializeAcornDisc(img);
    expect(out.ext).toBe('.hfe');
    expect(String.fromCharCode(...out.data.subarray(0, 8))).toBe('HXCPICFE');
  });

  it('saves a disc a sector dump cannot hold as .hfe, keeping what made it odd', () => {
    const img = parseSsd(dfsDisc(), false);
    img.tracks[2][0]!.sectors[4].st2 = 0x40;      // a deleted-data sector (protection)
    img.tracks[3][0]!.sectors[0].r = 0x2A;        // a sector ID outside 0-9
    img.tracks[3][0]!.sectorMap = new Map(img.tracks[3][0]!.sectors.map((s, i) => [s.r, i]));
    const out = serializeAcornDisc(img);
    expect(out.ext).toBe('.hfe');
    const back = parseHFE(out.data);
    expect(back.tracks[2][0]!.sectors[4].st2).toBe(0x40);
    expect(back.tracks[3][0]!.sectors[0].r).toBe(0x2A);
    expect(back.tracks[3][0]!.encoding).toBe('fm');
  });
});

describe('hasRegularLayout', () => {
  const DFS = { sectors: 10, firstId: 0, size: 256, encoding: 'fm' } as const;

  it('holds for a parsed .ssd', () => {
    expect(hasRegularLayout(parseSsd(dfsDisc(), false), DFS)).toBe(true);
  });

  it('fails on a sector whose ID cylinder is not its track', () => {
    const img = parseSsd(dfsDisc(), false);
    img.tracks[5][0]!.sectors[2].c = 6;
    expect(hasRegularLayout(img, DFS)).toBe(false);
  });

  it('fails on a CRC error, a weak sector or the other density', () => {
    const crc = parseSsd(dfsDisc(), false);
    crc.tracks[1][0]!.sectors[1].st1 = 0x20;
    expect(hasRegularLayout(crc, DFS)).toBe(false);
    const weak = parseSsd(dfsDisc(), false);
    weak.tracks[1][0]!.sectors[1].copies = [new Uint8Array(256), new Uint8Array(256).fill(1)];
    expect(hasRegularLayout(weak, DFS)).toBe(false);
    const mfm = parseSsd(dfsDisc(), false);
    mfm.tracks[7][0]!.encoding = 'mfm';
    expect(hasRegularLayout(mfm, DFS)).toBe(false);
  });

  it('fails on an unformatted track before a formatted one', () => {
    const img = parseSsd(dfsDisc(), false);
    img.tracks[10][0] = null;
    expect(hasRegularLayout(img, DFS)).toBe(false);
  });
});
