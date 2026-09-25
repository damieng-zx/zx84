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
