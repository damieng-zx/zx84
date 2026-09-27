/**
 * ZIP parser tests for archive features beyond the basic store/deflate cases
 * in tests/snapshot/zip.test.ts: encrypted entries, CP437 names, and zip64.
 * Archives are hand-assembled so every header field is explicit.
 */
import { describe, it, expect } from 'vitest';
import { unzip } from '@/media/zip.ts';

interface RawEntry {
  name: Uint8Array;
  data: Uint8Array;
  gpFlag?: number;
}

function ascii(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Stored-only ZIP with explicit general-purpose flags and raw name bytes. */
function buildZip(entries: RawEntry[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let pos = 0;
  for (const e of entries) {
    const lh = new Uint8Array(30 + e.name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, e.gpFlag ?? 0, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, e.name.length, true);
    lh.set(e.name, 30);

    const cd = new Uint8Array(46 + e.name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, e.gpFlag ?? 0, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, e.name.length, true);
    cv.setUint32(42, pos, true);
    cd.set(e.name, 46);

    local.push(lh, e.data);
    central.push(cd);
    pos += lh.length + e.data.length;
  }
  const cdBytes = concat(...central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdBytes.length, true);
  ev.setUint32(16, pos, true);
  return concat(...local, cdBytes, eocd);
}

describe('unzip — encrypted entries', () => {
  it('skips an encrypted entry and still returns the others', async () => {
    const zip = buildZip([
      { name: ascii('SECRET.TAP'), data: new Uint8Array([0xDE, 0xAD]), gpFlag: 0x0001 },
      { name: ascii('GAME.TAP'), data: new Uint8Array([1, 2, 3]) },
    ]);
    const entries = await unzip(zip);
    expect(entries.map((e) => e.name)).toEqual(['GAME.TAP']);
    expect(Array.from(entries[0].data)).toEqual([1, 2, 3]);
  });
});

describe('unzip — CP437 names', () => {
  it('decodes a name without the UTF-8 flag as IBM code page 437', async () => {
    // CP437: 0x81 = ü, 0x9A = Ü, 0xE1 = ß, 0xB0 = ░. (windows-1252 would
    // give U+0081, š, á and °.)
    const name = new Uint8Array([...ascii('M'), 0x81, 0x9A, 0xE1, 0xB0, ...ascii('.TAP')]);
    const entries = await unzip(buildZip([{ name, data: new Uint8Array([7]) }]));
    expect(entries.map((e) => e.name)).toEqual(['MüÜß░.TAP']);
  });

  it('decodes the last CP437 code point (0xFF) as a no-break space', async () => {
    const name = new Uint8Array([...ascii('A'), 0xFF, ...ascii('.TAP')]);
    const entries = await unzip(buildZip([{ name, data: new Uint8Array([7]) }]));
    expect(entries[0].name).toBe('A .TAP');
  });
});

// ── Zip64 ──────────────────────────────────────────────────────────────────

function u64(v: number): number[] {
  const lo = v >>> 0;
  const hi = Math.floor(v / 0x1_0000_0000);
  return [lo & 0xFF, (lo >>> 8) & 0xFF, (lo >>> 16) & 0xFF, lo >>> 24,
    hi & 0xFF, (hi >>> 8) & 0xFF, (hi >>> 16) & 0xFF, hi >>> 24];
}

/**
 * A Zip64 archive of stored entries: each central-directory entry's 32-bit
 * fields listed in `overflow` are set to 0xFFFFFFFF and the real values are
 * carried in a Zip64 extra field (in APPNOTE order); the EOCD's entry count
 * and CD offset are all-ones, with the real values in a Zip64 EOCD record
 * found via the locator.
 */
function buildZip64(
  entries: { name: string; data: Uint8Array }[],
  overflow: ('uncompressed' | 'compressed' | 'offset')[],
): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let pos = 0;
  for (const e of entries) {
    const name = ascii(e.name);
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);

    const zip64: number[] = [];
    if (overflow.includes('uncompressed')) zip64.push(...u64(e.data.length));
    if (overflow.includes('compressed')) zip64.push(...u64(e.data.length));
    if (overflow.includes('offset')) zip64.push(...u64(pos));
    // An unrelated extra field first, so the parser must walk the list.
    const extra = [0x55, 0x54, 1, 0, 0x00, 0x01, 0x00, zip64.length, 0, ...zip64];

    const cd = new Uint8Array(46 + name.length + extra.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, overflow.includes('compressed') ? 0xFFFFFFFF : e.data.length, true);
    cv.setUint32(24, overflow.includes('uncompressed') ? 0xFFFFFFFF : e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint32(42, overflow.includes('offset') ? 0xFFFFFFFF : pos, true);
    cd.set(name, 46);
    cd.set(extra, 46 + name.length);

    local.push(lh, e.data);
    central.push(cd);
    pos += lh.length + e.data.length;
  }
  const cdBytes = concat(...central);
  const cdOffset = pos;
  const recOffset = cdOffset + cdBytes.length;

  const rec = new Uint8Array(56);
  const rv = new DataView(rec.buffer);
  rv.setUint32(0, 0x06064b50, true);
  rec.set(u64(44), 4);                 // size of the remaining record
  rec.set(u64(entries.length), 24);    // entries on this disk
  rec.set(u64(entries.length), 32);    // total entries
  rec.set(u64(cdBytes.length), 40);
  rec.set(u64(cdOffset), 48);

  const loc = new Uint8Array(20);
  const lcv = new DataView(loc.buffer);
  lcv.setUint32(0, 0x07064b50, true);
  loc.set(u64(recOffset), 8);
  lcv.setUint32(16, 1, true);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 0xFFFF, true);
  ev.setUint16(10, 0xFFFF, true);
  ev.setUint32(12, 0xFFFFFFFF, true);
  ev.setUint32(16, 0xFFFFFFFF, true);
  return concat(...local, cdBytes, rec, loc, eocd);
}

describe('unzip — Zip64', () => {
  it('reads entries through the Zip64 EOCD record and extra-field sizes', async () => {
    const zip = buildZip64([
      { name: 'A.TAP', data: new Uint8Array([1, 2, 3]) },
      { name: 'B.TZX', data: new Uint8Array([4, 5]) },
    ], ['uncompressed', 'compressed', 'offset']);
    const entries = await unzip(zip);
    expect(entries.map((e) => [e.name, Array.from(e.data)])).toEqual([
      ['A.TAP', [1, 2, 3]],
      ['B.TZX', [4, 5]],
    ]);
  });

  it('reads only the overflowed fields from the Zip64 extra field (offset alone)', async () => {
    // Only the local header offset overflowed: the extra field holds just
    // that one 8-byte value, which must not be mistaken for a size.
    const zip = buildZip64([
      { name: 'X.TAP', data: new Uint8Array([9, 8, 7, 6]) },
      { name: 'Y.TAP', data: new Uint8Array([5]) },
    ], ['offset']);
    const entries = await unzip(zip);
    expect(entries.map((e) => [e.name, Array.from(e.data)])).toEqual([
      ['X.TAP', [9, 8, 7, 6]],
      ['Y.TAP', [5]],
    ]);
  });
});
