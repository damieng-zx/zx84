import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { unzip } from '@/snapshot/zip.ts';

// ── Low-level ZIP helpers (used by both buildZip and hand-rolled tests) ────

const LFH_SIG = 0x04034b50;
const CD_SIG  = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function makeLocalFileHeader(opts: {
  name: Uint8Array;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc?: number;
  gpFlag?: number;
}): Uint8Array {
  const lh = new Uint8Array(30 + opts.name.length);
  const v = new DataView(lh.buffer);
  v.setUint32(0, LFH_SIG, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, opts.gpFlag ?? 0, true);
  v.setUint16(8, opts.method, true);
  v.setUint32(14, opts.crc ?? 0, true);
  v.setUint32(18, opts.compressedSize, true);
  v.setUint32(22, opts.uncompressedSize, true);
  v.setUint16(26, opts.name.length, true);
  lh.set(opts.name, 30);
  return lh;
}

function makeCentralDirEntry(opts: {
  name: Uint8Array;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  crc?: number;
  gpFlag?: number;
}): Uint8Array {
  const cd = new Uint8Array(46 + opts.name.length);
  const v = new DataView(cd.buffer);
  v.setUint32(0, CD_SIG, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 20, true);
  v.setUint16(8, opts.gpFlag ?? 0, true);
  v.setUint16(10, opts.method, true);
  v.setUint32(16, opts.crc ?? 0, true);
  v.setUint32(20, opts.compressedSize, true);
  v.setUint32(24, opts.uncompressedSize, true);
  v.setUint16(28, opts.name.length, true);
  v.setUint32(42, opts.localHeaderOffset, true);
  cd.set(opts.name, 46);
  return cd;
}

function makeEocd(opts: { totalEntries: number; cdSize: number; cdOffset: number }): Uint8Array {
  const eocd = new Uint8Array(22);
  const v = new DataView(eocd.buffer);
  v.setUint32(0, EOCD_SIG, true);
  v.setUint16(8, opts.totalEntries, true);
  v.setUint16(10, opts.totalEntries, true);
  v.setUint32(12, opts.cdSize, true);
  v.setUint32(16, opts.cdOffset, true);
  return eocd;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

// ── ZIP builder ─────────────────────────────────────────────────────────────
//
// Hand-rolled minimal ZIP writer. Supports store (method 0) and deflate
// (method 8) entries. Names are ASCII unless `utf8: true`.

interface BuildEntry {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  utf8?: boolean;
}

function crc32(buf: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries: BuildEntry[], opts: { trailingComment?: Uint8Array } = {}): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const cdChunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let localPos = 0;

  for (const e of entries) {
    const method = e.method ?? 0;
    const nameBytes = new TextEncoder().encode(e.name);
    const uncompressedSize = e.data.length;
    const crc = crc32(e.data);
    const payload = method === 8 ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const compressedSize = payload.length;
    const gpFlag = e.utf8 ? (1 << 11) : 0;

    // Local file header
    const lh = new Uint8Array(30 + nameBytes.length);
    const lhView = new DataView(lh.buffer);
    lhView.setUint32(0, 0x04034b50, true);
    lhView.setUint16(4, 20, true);
    lhView.setUint16(6, gpFlag, true);
    lhView.setUint16(8, method, true);
    lhView.setUint32(14, crc, true);
    lhView.setUint32(18, compressedSize, true);
    lhView.setUint32(22, uncompressedSize, true);
    lhView.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);

    offsets.push(localPos);
    localChunks.push(lh, payload);
    localPos += lh.length + payload.length;

    // Central directory entry
    const cd = new Uint8Array(46 + nameBytes.length);
    const cdView = new DataView(cd.buffer);
    cdView.setUint32(0, 0x02014b50, true);
    cdView.setUint16(4, 20, true);
    cdView.setUint16(6, 20, true);
    cdView.setUint16(8, gpFlag, true);
    cdView.setUint16(10, method, true);
    cdView.setUint32(16, crc, true);
    cdView.setUint32(20, compressedSize, true);
    cdView.setUint32(24, uncompressedSize, true);
    cdView.setUint16(28, nameBytes.length, true);
    cdView.setUint32(42, offsets[offsets.length - 1], true);
    cd.set(nameBytes, 46);
    cdChunks.push(cd);
  }

  const cdOffset = localPos;
  const cdSize = cdChunks.reduce((n, c) => n + c.length, 0);
  const comment = opts.trailingComment ?? new Uint8Array(0);

  const eocd = new Uint8Array(22 + comment.length);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdOffset, true);
  eocdView.setUint16(20, comment.length, true);
  eocd.set(comment, 22);

  const total = localPos + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of localChunks) { out.set(c, p); p += c.length; }
  for (const c of cdChunks) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('unzip — error handling', () => {
  it('rejects a buffer with no EOCD signature', async () => {
    const garbage = new Uint8Array(100);
    await expect(unzip(garbage)).rejects.toThrow(/EOCD not found/);
  });

  it('rejects a buffer too small to contain an EOCD', async () => {
    const tiny = new Uint8Array(10);
    await expect(unzip(tiny)).rejects.toThrow(/EOCD not found/);
  });

  it('throws when a local file header signature is invalid', async () => {
    const zip = buildZip([{ name: 'game.sna', data: bytes(1, 2, 3, 4) }]);
    // Corrupt the local header signature (offset 0 — first entry sits at file start).
    zip[0] = 0xFF;
    await expect(unzip(zip)).rejects.toThrow(/Invalid local file header/);
  });
});

describe('unzip — stored entries (method 0)', () => {
  it('extracts a single stored .sna entry', async () => {
    const payload = new Uint8Array(64);
    for (let i = 0; i < payload.length; i++) payload[i] = i;
    const zip = buildZip([{ name: 'game.sna', data: payload }]);

    const out = await unzip(zip);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('game.sna');
    expect(Array.from(out[0].data)).toEqual(Array.from(payload));
  });

  it('extracts multiple stored entries in central-directory order', async () => {
    const a = bytes(0xAA, 0xBB);
    const b = bytes(0x11, 0x22, 0x33);
    const zip = buildZip([
      { name: 'one.sna', data: a },
      { name: 'two.tap', data: b },
    ]);

    const out = await unzip(zip);
    expect(out.map(e => e.name)).toEqual(['one.sna', 'two.tap']);
    expect(Array.from(out[0].data)).toEqual([0xAA, 0xBB]);
    expect(Array.from(out[1].data)).toEqual([0x11, 0x22, 0x33]);
  });

  it('locates the EOCD when a trailing ZIP comment is present', async () => {
    const zip = buildZip(
      [{ name: 'game.z80', data: bytes(9, 8, 7) }],
      { trailingComment: new TextEncoder().encode('hello-comment') },
    );
    const out = await unzip(zip);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('game.z80');
    expect(Array.from(out[0].data)).toEqual([9, 8, 7]);
  });
});

describe('unzip — deflated entries (method 8)', () => {
  it('inflates a single small deflated entry', async () => {
    const payload = new TextEncoder().encode('hello world from a deflated zip entry');
    const zip = buildZip([{ name: 'doc.tap', data: payload, method: 8 }]);

    const out = await unzip(zip);
    expect(out).toHaveLength(1);
    expect(Array.from(out[0].data)).toEqual(Array.from(payload));
  });

  it('inflates a larger payload that produces multiple chunks', async () => {
    // 128 KB of varied data — large enough to potentially span multiple
    // DecompressionStream reads, exercising the multi-chunk branch.
    const payload = new Uint8Array(128 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + (i >> 3)) & 0xFF;
    const zip = buildZip([{ name: 'big.dsk', data: payload, method: 8 }]);

    const out = await unzip(zip);
    expect(out).toHaveLength(1);
    expect(out[0].data.length).toBe(payload.length);
    expect(out[0].data).toEqual(payload);
  });
});

describe('unzip — filtering', () => {
  it('skips directory entries', async () => {
    const zip = buildZip([
      { name: 'folder/', data: new Uint8Array(0) },
      { name: 'folder/game.sna', data: bytes(1, 2) },
    ]);
    const out = await unzip(zip);
    expect(out.map(e => e.name)).toEqual(['folder/game.sna']);
  });

  it('skips files without a loadable extension', async () => {
    const zip = buildZip([
      { name: 'readme.txt', data: bytes(1) },
      { name: 'game.sna', data: bytes(2) },
      { name: 'cover.png', data: bytes(3) },
    ]);
    const out = await unzip(zip);
    expect(out.map(e => e.name)).toEqual(['game.sna']);
  });

  it('accepts all supported snapshot, tape, and disk extensions (case-insensitive)', async () => {
    const names = [
      'a.sna', 'b.Z80', 'c.szx', 'd.SP',
      'e.tap', 'f.TZX', 'g.dsk',
    ];
    const zip = buildZip(names.map(n => ({ name: n, data: bytes(0xFF) })));
    const out = await unzip(zip);
    expect(out.map(e => e.name)).toEqual(names);
  });

  it('skips entries with unsupported compression methods', async () => {
    // Build a valid file then patch the central-directory method field to 99 (AE).
    const zip = buildZip([
      { name: 'a.sna', data: bytes(1) },
      { name: 'b.sna', data: bytes(2) },
    ]);
    // Walk to find the second CD entry and set its method to 99.
    const view = new DataView(zip.buffer);
    let pos = 0;
    let cdStart = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        cdStart = view.getUint32(i + 16, true);
        break;
      }
    }
    expect(cdStart).toBeGreaterThan(0);
    pos = cdStart;
    // Skip first CD entry
    const nameLen0 = view.getUint16(pos + 28, true);
    const extraLen0 = view.getUint16(pos + 30, true);
    const commentLen0 = view.getUint16(pos + 32, true);
    pos += 46 + nameLen0 + extraLen0 + commentLen0;
    // Patch method on second entry
    view.setUint16(pos + 10, 99, true);

    const out = await unzip(zip);
    expect(out.map(e => e.name)).toEqual(['a.sna']);
  });
});

describe('unzip — name decoding', () => {
  it('decodes UTF-8 names when the UTF-8 flag is set', async () => {
    const name = 'jüegö-€.sna';
    const zip = buildZip([{ name, data: bytes(0x42), utf8: true }]);
    const out = await unzip(zip);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe(name);
  });
});

describe('unzip — empty archive', () => {
  it('returns an empty array for a ZIP with no entries', async () => {
    const zip = buildZip([]);
    const out = await unzip(zip);
    expect(out).toEqual([]);
  });
});

// ── Central-directory walk: halt on corrupt entry ───────────────────────────

describe('unzip — central-directory walk halts on bad signature', () => {
  it('stops iterating CD entries when a later entry has an invalid signature', async () => {
    // EOCD claims 2 entries, but the second CD entry has a zeroed signature.
    // The loader must keep entry 1 and break before entry 2 without throwing.
    const name = new TextEncoder().encode('a.sna');
    const payload = new Uint8Array([0xAA, 0xBB, 0xCC]);

    const lh = makeLocalFileHeader({
      name, method: 0,
      compressedSize: payload.length,
      uncompressedSize: payload.length,
    });
    const cd1 = makeCentralDirEntry({
      name, method: 0,
      compressedSize: payload.length,
      uncompressedSize: payload.length,
      localHeaderOffset: 0,
    });
    const cd2 = new Uint8Array(46); // sig = 0 → invalid

    const cdOffset = lh.length + payload.length;
    const cdSize = cd1.length + cd2.length;
    const eocd = makeEocd({ totalEntries: 2, cdSize, cdOffset });
    const zip = concat(lh, payload, cd1, cd2, eocd);

    const out = await unzip(zip);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('a.sna');
    expect(Array.from(out[0].data)).toEqual([0xAA, 0xBB, 0xCC]);
  });
});

// ── inflate: multi-chunk concatenation ──────────────────────────────────────

describe('unzip — multi-chunk inflate concatenation', () => {
  // Node's DecompressionStream emits inflated output in ~16 KiB chunks once
  // the total exceeds 16 KiB, so 1 MiB reliably triggers the multi-chunk path.

  it('concatenates chunks for large deflated payloads', async () => {
    const SIZE = 1024 * 1024;
    const raw = new Uint8Array(SIZE);
    const deflated = new Uint8Array(deflateRawSync(raw));
    const name = new TextEncoder().encode('big.dsk');

    const lh = makeLocalFileHeader({
      name, method: 8,
      compressedSize: deflated.length,
      uncompressedSize: raw.length,
    });
    const cd = makeCentralDirEntry({
      name, method: 8,
      compressedSize: deflated.length,
      uncompressedSize: raw.length,
      localHeaderOffset: 0,
    });
    const eocd = makeEocd({
      totalEntries: 1,
      cdSize: cd.length,
      cdOffset: lh.length + deflated.length,
    });

    const out = await unzip(concat(lh, deflated, cd, eocd));
    expect(out).toHaveLength(1);
    expect(out[0].data.length).toBe(SIZE);
    expect(out[0].data[0]).toBe(0);
    expect(out[0].data[SIZE / 2]).toBe(0);
    expect(out[0].data[SIZE - 1]).toBe(0);
  });

  it('uses summed chunk length when CD uncompressedSize is zero', async () => {
    // Trip the `expectedSize > 0 ? expectedSize : totalLen` ternary's else
    // branch: declare uncompressedSize=0 in the CD but ship a payload that
    // actually inflates to >16 KiB (multi-chunk).
    const SIZE = 1024 * 1024;
    const raw = new Uint8Array(SIZE);
    const deflated = new Uint8Array(deflateRawSync(raw));
    const name = new TextEncoder().encode('big.dsk');

    const lh = makeLocalFileHeader({
      name, method: 8,
      compressedSize: deflated.length,
      uncompressedSize: raw.length,
    });
    const cd = makeCentralDirEntry({
      name, method: 8,
      compressedSize: deflated.length,
      uncompressedSize: 0,           // ← lie: tell loader we don't know the size
      localHeaderOffset: 0,
    });
    const eocd = makeEocd({
      totalEntries: 1,
      cdSize: cd.length,
      cdOffset: lh.length + deflated.length,
    });

    const out = await unzip(concat(lh, deflated, cd, eocd));
    expect(out).toHaveLength(1);
    expect(out[0].data.length).toBe(SIZE);
    expect(out[0].data[SIZE - 1]).toBe(0);
  });
});
