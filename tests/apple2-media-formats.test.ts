/**
 * Apple II disk image formats beyond the plain sector image: WOZ 1 / 2 / 2.1,
 * `.nib`, `.2mg` and the 13-sector `.d13` with its 5-and-3 encoding.
 *
 * WOZ files are built here byte by byte from the WOZ reference's layout (header
 * "WOZ2" FF 0A 0D 0A + CRC-32 of the rest; INFO 60 bytes; TMAP 160 bytes with
 * FF for no track; WOZ 2 TRKS entries of start block / block count / bit count
 * with the bits in 512-byte blocks from block 3; WOZ 1 TRKS records of 6656
 * bytes with the bit count at +6648; bits packed most significant first), and
 * CRCs come from Node's zlib, not the codec. 2MG headers follow the published
 * 64-byte layout. The 5-and-3 code table is the 32 bytes with the high bit set
 * and no two adjacent zero bits, less the reserved $AA and $D5.
 */

import { describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import {
  GCR53_WRITE_TABLE, decodeNibbleSectors, decodeSector5and3, encodeSector5and3, encodeTrack,
  fiveAndThreeChecksumOk, parseApple2Disk, parseApple2Disk13, serializeApple2Disk13,
} from '@/media/floppy/apple2.ts';
import {
  Apple2BitWriter, bitAt, bitTrackToNib, decodeBitTrack, encodeTrackBits, nibToBitTrack,
  nibblesFromBits, standardTmap,
} from '@/media/floppy/apple2-bitstream.ts';
import { fluxToBits, isWoz, parseWoz, serializeWoz } from '@/media/floppy/apple2-woz.ts';
import { parseApple2Media, serializeApple2Media } from '@/media/floppy/apple2-media.ts';

const enc = (s: string) => new TextEncoder().encode(s);

interface WozTrackSpec { bits: Uint8Array; bitCount: number }

/** Hand-build a WOZ 2 (or 2.1 with `flux`) file. */
function buildWoz2(opts: {
  tracks: WozTrackSpec[]; tmap: number[] | Uint8Array; creator?: string; writeProtected?: boolean;
  bitTiming?: number; diskType?: number; flux?: { map: number[]; data: Uint8Array[] };
}): Uint8Array {
  const entries: { bytes: Uint8Array; count: number }[] = opts.tracks.map(t => ({ bytes: t.bits, count: t.bitCount }));
  const fluxBase = entries.length;
  for (const f of opts.flux?.data ?? []) entries.push({ bytes: f, count: f.length });
  const blocks = entries.map(e => Math.ceil(e.bytes.length / 512));
  const dataBlocks = blocks.reduce((a, b) => a + b, 0);
  const fluxChunk = opts.flux ? 8 + 160 : 0;
  const size = 1536 + dataBlocks * 512 + fluxChunk;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out.set([0x57, 0x4F, 0x5A, 0x32, 0xFF, 0x0A, 0x0D, 0x0A]);
  out.set(enc('INFO'), 12); v.setUint32(16, 60, true);
  out[20] = opts.flux ? 3 : 2;
  out[21] = opts.diskType ?? 1;
  out[22] = opts.writeProtected ? 1 : 0;
  out.fill(0x20, 25, 57); out.set(enc(opts.creator ?? 'Applesauce v1.0'), 25);
  out[57] = 1; out[58] = 1; out[59] = opts.bitTiming ?? 32;
  out.set(enc('TMAP'), 80); v.setUint32(84, 160, true);
  out.fill(0xFF, 88, 248);
  out.set(opts.tmap, 88);
  out.set(enc('TRKS'), 248); v.setUint32(252, 1280 + dataBlocks * 512, true);
  let block = 3;
  entries.forEach((e, i) => {
    v.setUint16(256 + i * 8, block, true);
    v.setUint16(258 + i * 8, blocks[i], true);
    v.setUint32(260 + i * 8, e.count, true);
    out.set(e.bytes, block * 512);
    block += blocks[i];
  });
  if (opts.flux) {
    const at = block * 512;
    out.set(enc('FLUX'), at); v.setUint32(at + 4, 160, true);
    out.fill(0xFF, at + 8, at + 168);
    opts.flux.map.forEach((idx, qt) => { if (idx !== 0xFF) out[at + 8 + qt] = fluxBase + idx; });
  }
  v.setUint32(8, crc32(out.subarray(12)), true);
  return out;
}

describe('WOZ images', () => {
  const track = { bits: Uint8Array.from([0xD5, 0xAA, 0x96, 0xFF]), bitCount: 30 };

  it('recognises the WOZ1 and WOZ2 headers only with the FF 0A 0D 0A tail', () => {
    expect(isWoz(buildWoz2({ tracks: [track], tmap: [0] }))).toBe(true);
    const bad = buildWoz2({ tracks: [track], tmap: [0] });
    bad[5] = 0x0D;
    expect(isWoz(bad)).toBe(false);
  });

  it('reads INFO, maps quarter tracks with FF as blank, and unpacks bits MSB first', () => {
    const woz = parseWoz(buildWoz2({
      tracks: [track], tmap: [0, 0, 0xFF, 0xFF, 0], creator: 'Applesauce v1.0', writeProtected: true, bitTiming: 31,
    }));
    expect(woz.version).toBe(2);
    expect(woz.creator).toBe('Applesauce v1.0');
    expect(woz.writeProtected).toBe(true);
    expect(woz.bitTiming).toBe(31);
    expect(woz.bootSectorFormat).toBe(1);
    expect(Array.from(woz.tmap.subarray(0, 6))).toEqual([0, 0, 0xFF, 0xFF, 0, 0xFF]);
    expect(woz.tracks).toHaveLength(1);
    expect(woz.tracks[0].bitCount).toBe(30);
    // $D5 = 1101 0101, most significant bit first.
    expect(Array.from({ length: 8 }, (_, i) => bitAt(woz.tracks[0], i))).toEqual([1, 1, 0, 1, 0, 1, 0, 1]);
  });

  it('rejects a CRC mismatch, and accepts a CRC of zero as "not computed"', () => {
    const file = buildWoz2({ tracks: [track], tmap: [0] });
    file[600] ^= 1;
    expect(() => parseWoz(file)).toThrow(/CRC/);
    new DataView(file.buffer).setUint32(8, 0, true);
    expect(() => parseWoz(file)).not.toThrow();
  });

  it('rejects 3.5-inch disks', () => {
    expect(() => parseWoz(buildWoz2({ tracks: [track], tmap: [0], diskType: 2 }))).toThrow(/3\.5/);
  });

  it('reads WOZ 1 track records (6646 bytes of bits, bit count at +6648)', () => {
    const size = 12 + 8 + 60 + 8 + 160 + 8 + 2 * 6656;
    const out = new Uint8Array(size);
    const v = new DataView(out.buffer);
    out.set([0x57, 0x4F, 0x5A, 0x31, 0xFF, 0x0A, 0x0D, 0x0A]);
    out.set(enc('INFO'), 12); v.setUint32(16, 60, true);
    out[20] = 1; out[21] = 1; out.fill(0x20, 25, 57);
    out.set(enc('TMAP'), 80); v.setUint32(84, 160, true);
    out.fill(0xFF, 88, 248); out[88] = 1;                 // quarter track 0 -> TRKS record 1
    out.set(enc('TRKS'), 248); v.setUint32(252, 2 * 6656, true);
    const rec1 = 256 + 6656;
    out[rec1] = 0xAB;
    v.setUint16(rec1 + 6646, 1, true);                    // bytes used
    v.setUint16(rec1 + 6648, 8, true);                    // bit count
    v.setUint32(8, crc32(out.subarray(12)), true);
    const woz = parseWoz(out);
    expect(woz.version).toBe(1);
    expect(woz.bitTiming).toBe(32);                       // WOZ 1 has no timing field: 4 µs
    expect(woz.tracks[woz.tmap[0]].bitCount).toBe(8);
    expect(woz.tracks[woz.tmap[0]].data[0]).toBe(0xAB);
  });

  it('turns FLUX intervals (125 ns ticks, 255 = carry on) into bit cells', () => {
    // 32 ticks = one 4 µs cell: "1"; 64 = "01"; 96 = "001"; 255 + 33 = 288 = 9 cells.
    expect(Array.from({ length: 15 }, (_, i) => bitAt(fluxToBits(Uint8Array.from([32, 64, 96, 255, 33]), 32), i)))
      .toEqual([1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('uses a WOZ 2.1 FLUX track in place of the bit track for its quarter track', () => {
    const flux = new Uint8Array(64).fill(32);              // 64 transitions one cell apart
    const woz = parseWoz(buildWoz2({ tracks: [track], tmap: [0, 0], flux: { map: [0], data: [flux] } }));
    expect(woz.infoVersion).toBe(3);
    expect(woz.fluxQuarterTracks).toBe(1);
    expect(woz.tracks[woz.tmap[0]].bitCount).toBe(64);     // from the flux
    expect(woz.tracks[woz.tmap[1]].bitCount).toBe(30);     // still the bit track
  });

  it('writes WOZ 2: INFO/TMAP/TRKS in place, bits from block 3, CRC over the rest', () => {
    const t = encodeTrackBits(new Array(16).fill(new Uint8Array(256)), 0, 254, 16);
    const tmap = standardTmap(1);
    const out = serializeWoz({ tmap, tracks: [t], bitTiming: 32, writeProtected: true, creator: 'zx84' });
    const v = new DataView(out.buffer);
    expect(String.fromCharCode(...out.subarray(0, 4))).toBe('WOZ2');
    expect(Array.from(out.subarray(4, 8))).toEqual([0xFF, 0x0A, 0x0D, 0x0A]);
    expect(v.getUint32(8, true)).toBe(crc32(out.subarray(12)));
    expect(String.fromCharCode(...out.subarray(12, 16))).toBe('INFO');
    expect(out[22]).toBe(1);                               // write protected
    expect(String.fromCharCode(...out.subarray(80, 84))).toBe('TMAP');
    expect(out[88 + 2]).toBe(0xFF);                        // half track 0.5 blank
    expect(String.fromCharCode(...out.subarray(248, 252))).toBe('TRKS');
    expect(v.getUint16(256, true)).toBe(3);                // first track at block 3
    expect(v.getUint32(260, true)).toBe(t.bitCount);
    expect(out.subarray(1536, 1536 + 16)).toEqual(t.data.subarray(0, 16));
    const back = parseWoz(out);
    expect(back.tracks[back.tmap[0]].data).toEqual(t.data);
    expect(back.writeProtected).toBe(true);
  });

  it('mounts a WOZ disk with its sectors decoded for the drive pane, and saves it back as WOZ', () => {
    const sectors = Array.from({ length: 16 }, (_, r) => new Uint8Array(256).fill(r));
    const t0 = encodeTrackBits(sectors, 0, 254, 16);
    const file = buildWoz2({ tracks: [{ bits: t0.data, bitCount: t0.bitCount }], tmap: standardTmap(1) });
    const disk = parseApple2Media(file, 'game.woz');
    expect(disk.apple2.source).toBe('woz');
    expect(disk.tracks[0][0]!.sectors.map(s => s.data[0])).toEqual(Array.from({ length: 16 }, (_, r) => r));
    const saved = serializeApple2Media(disk);
    expect(saved.ext).toBe('.woz');
    expect(parseWoz(saved.data).tracks[0].data).toEqual(t0.data);
  });
});

describe('.nib images', () => {
  /** A plain-nibble track holding one sector. */
  const nibTrack = (): Uint8Array => encodeTrack([new Uint8Array(256), ...new Array(15).fill(null)], 0, 254);

  it('widens gap $FFs into ten-cell sync bytes but leaves field bytes at eight', () => {
    const nib = new Uint8Array(6656).fill(0xFF);
    // Data field: D5 AA AD, then 343 bytes including $FF codes, then DE AA EB.
    const field = [0xD5, 0xAA, 0xAD, ...new Array(343).fill(0xFF), 0xDE, 0xAA, 0xEB];
    nib.set(field, 100);
    const bits = nibToBitTrack(nib);
    // 6656 bytes: 343 of them $FF inside the field stay 8 cells, the rest of the
    // $FFs (6656 - 349 = 6307) become 10.
    expect(bits.bitCount).toBe(349 * 8 + 6307 * 10);
    // The track starts at the prologue; the first gap $FF after the epilogue is
    // followed by two 0 cells.
    const after = 349 * 8;
    expect(Array.from({ length: 10 }, (_, i) => bitAt(bits, after + i))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
  });

  it('reads back the same nibbles it was built from', () => {
    const nib = nibTrack();
    const bits = nibToBitTrack(nib);
    const start = nib.findIndex((b, i) => b === 0xD5 && nib[i + 1] === 0xAA);
    const rotated = Uint8Array.from([...nib.subarray(start), ...nib.subarray(0, start)]);
    expect(bitTrackToNib(bits)).toEqual(rotated);
  });

  it('mounts a .nib and saves it back as nibbles', () => {
    const data = new Uint8Array(35 * 6656);
    const sector = new Uint8Array(256).fill(0x42);
    for (let t = 0; t < 35; t++) data.set(encodeTrack(new Array(16).fill(sector), t, 254), t * 6656);
    const disk = parseApple2Media(data, 'x.nib');
    expect(disk.apple2.source).toBe('nib');
    expect(disk.tracks[34][0]!.sectors).toHaveLength(16);
    expect(disk.tracks[34][0]!.sectors[7].data[0]).toBe(0x42);
    const saved = serializeApple2Media(disk);
    expect(saved.ext).toBe('.nib');
    expect(saved.data.length).toBe(35 * 6656);
    expect(decodeNibbleSectors(saved.data.subarray(0, 6656), 16, true)[3]).toEqual(sector);
  });
});

describe('.2mg images', () => {
  function twoImg(format: number, body: Uint8Array, flags = 0, comment = ''): Uint8Array {
    const c = enc(comment);
    const out = new Uint8Array(64 + body.length + c.length);
    const v = new DataView(out.buffer);
    out.set(enc('2IMGWOOF'));
    v.setUint16(8, 64, true); v.setUint16(10, 1, true);
    v.setUint32(12, format, true);
    v.setUint32(16, flags, true);
    v.setUint32(20, format === 1 ? 280 : 0, true);
    v.setUint32(24, 64, true); v.setUint32(28, body.length, true);
    if (c.length) { v.setUint32(32, 64 + body.length, true); v.setUint32(36, c.length, true); }
    out.set(body, 64);
    out.set(c, 64 + body.length);
    return out;
  }

  it('reads the order, the locked flag and the volume number', () => {
    const body = new Uint8Array(140 * 1024);
    body[256] = 0x77;                                   // file sector 1 of track 0
    const disk = parseApple2Media(twoImg(1, body, 0x80000000 | 0x100 | 99), 'x.2mg');
    expect(disk.apple2.order).toBe('prodos');
    expect(disk.apple2.bits.writeProtected).toBe(true);
    expect(disk.apple2.volume).toBe(99);
    // ProDOS order: file sector 1 is physical sector 2.
    expect(disk.tracks[0][0]!.sectors[2].data[0]).toBe(0x77);
  });

  it('saves the same container back, comment and all', () => {
    const body = new Uint8Array(140 * 1024);
    const disk = parseApple2Media(twoImg(0, body, 0, 'hello'), 'x.2mg');
    disk.tracks[1][0]!.sectors[0].data[0] = 0x5A;
    const saved = serializeApple2Media(disk);
    expect(saved.ext).toBe('.2mg');
    const v = new DataView(saved.data.buffer);
    expect(String.fromCharCode(...saved.data.subarray(0, 4))).toBe('2IMG');
    expect(v.getUint32(28, true)).toBe(140 * 1024);
    expect(new TextDecoder().decode(saved.data.subarray(v.getUint32(32, true), v.getUint32(32, true) + 5))).toBe('hello');
    expect(saved.data[64 + 4096]).toBe(0x5A);            // DOS order: physical 0 = file sector 0
  });

  it('refuses a 3.5-inch (800K) image', () => {
    expect(() => parseApple2Media(twoImg(1, new Uint8Array(800 * 1024)), 'big.2mg')).toThrow(/5\.25/);
  });
});

describe('13-sector 5-and-3', () => {
  it('uses the 32 disk bytes with no two adjacent zero bits, less $AA and $D5', () => {
    expect(GCR53_WRITE_TABLE).toEqual([
      0xAB, 0xAD, 0xAE, 0xAF, 0xB5, 0xB6, 0xB7, 0xBA, 0xBB, 0xBD, 0xBE, 0xBF,
      0xD6, 0xD7, 0xDA, 0xDB, 0xDD, 0xDE, 0xDF, 0xEA, 0xEB, 0xED, 0xEE, 0xEF,
      0xF5, 0xF6, 0xF7, 0xFA, 0xFB, 0xFD, 0xFE, 0xFF,
    ]);
  });

  it('round-trips a sector through 410 values and a checksum, and catches a bad value', () => {
    const sector = Uint8Array.from({ length: 256 }, (_, i) => (i * 37 + 11) & 0xFF);
    const values = encodeSector5and3(sector);
    expect(values).toHaveLength(411);
    expect(values.every(x => x < 32)).toBe(true);
    expect(fiveAndThreeChecksumOk(values)).toBe(true);
    expect(decodeSector5and3(values)).toEqual(sector);
    values[200] ^= 1;
    expect(fiveAndThreeChecksumOk(values)).toBe(false);
  });

  it('keeps each byte\'s top five bits whole in one value', () => {
    const sector = new Uint8Array(256);
    sector[0] = 0xF8;                       // top five bits 11111, low three 000
    const values = encodeSector5and3(sector);
    // The running XOR of the values recovers the raw ones; the first primary
    // value (index 154) is byte 0's top five bits.
    let acc = 0;
    for (let k = 0; k <= 154; k++) acc ^= values[k];
    expect(acc).toBe(0x1F);
  });

  it('parses a .d13 in physical order and nibblizes it with D5 AA B5 address marks', () => {
    const data = new Uint8Array(35 * 13 * 256);
    for (let r = 0; r < 13; r++) data[r * 256] = 0x30 + r;
    const image = parseApple2Disk13(data);
    expect(image.tracks[0][0]!.sectors.map(s => s.data[0])).toEqual(Array.from({ length: 13 }, (_, r) => 0x30 + r));
    expect(serializeApple2Disk13(image)).toEqual(data);
    const disk = parseApple2Media(data, 'old.d13');
    expect(disk.apple2.sectorsPerTrack).toBe(13);
    const track = disk.apple2.bits.tracks[disk.apple2.bits.tmap[0]];
    const nibbles = nibblesFromBits(track, 0, track.bitCount);
    const at = nibbles.findIndex((b, i) => b === 0xD5 && nibbles[i + 1] === 0xAA);
    expect(nibbles[at + 2]).toBe(0xB5);
    expect(decodeBitTrack(track, 13).map(s => s?.[0])).toEqual(Array.from({ length: 13 }, (_, r) => 0x30 + r));
    expect(serializeApple2Media(disk).ext).toBe('.d13');
  });
});

describe('nibblized bit tracks', () => {
  it('write self-sync gaps as $FF and two 0 cells, and fit one 300 RPM revolution', () => {
    const t = encodeTrackBits(new Array(16).fill(new Uint8Array(256)), 0, 254, 16);
    // One revolution at 4 cycles a cell: 0.2 s × 1,022,727 Hz / 4 = 51,136 cells.
    expect(t.bitCount).toBeLessThanOrEqual(51136);
    expect(t.bitCount).toBeGreaterThan(51136 - 10);
    expect(Array.from({ length: 20 }, (_, i) => bitAt(t, i))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
  });

  it('decode back to the sectors a 16-sector DOS image holds', () => {
    const raw = new Uint8Array(35 * 4096);
    for (let i = 0; i < 4096; i++) raw[4096 * 5 + i] = i * 7;
    const image = parseApple2Disk(raw, 'dos');
    const sectors = image.tracks[5][0]!.sectors.map(s => s.data);
    const t = encodeTrackBits(sectors, 5, 254, 16);
    expect(decodeBitTrack(t, 16)).toEqual(sectors);
  });

  it('a reader that starts mid-byte falls into step within the sync gap', () => {
    const w = new Apple2BitWriter();
    w.sync(8);
    for (const b of [0xD5, 0xAA, 0x96]) w.byte(b);
    const t = w.finish();
    for (let start = 0; start < 10; start++) {
      const got = Array.from(nibblesFromBits(t, start, t.bitCount - start));
      expect(got.slice(-3), `start ${start}`).toEqual([0xD5, 0xAA, 0x96]);
    }
  });
});
