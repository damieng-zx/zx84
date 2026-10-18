/**
 * build-mascot.ts — render Blip, the ZX84 robot mascot, from its pixel grids.
 *
 *   npm run mascot
 *
 * Blip is pixel art: the head is a 16×16 grid so the favicon is pixel-perfect
 * at its native size, and the full-body mascot reuses that head on a 20×28
 * grid. Edit the grids below and re-run; everything in public/ is regenerated:
 *
 *   public/favicon.svg           head, 16×16 viewBox (modern browsers)
 *   public/favicon.ico           head at 16/32/48 px (legacy browsers, bookmarks)
 *   public/apple-touch-icon.png  head ×10 on the app's slate, 180×180 (iOS home screen)
 *   public/mascot.svg            full body, 20×28 viewBox
 *
 * SVGs use crispEdges, so scale them by whole multiples of the grid size to
 * keep the pixels square. No dependencies — PNGs are encoded with node:zlib.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PAL: Record<string, string> = {
  K: '#0b0b14', // outline
  V: '#b4f6f8', // dome shine
  T: '#5ee0e8', // teal body
  U: '#2a9aa8', // teal shade
  W: '#eef0f6', // eye whites
  L: '#c3c7d6', // hands
  D: '#7c8298', // neck / legs
  S: '#141830', // chest panel
  P: '#ff8ac8', // cheeks
  M: '#ff4cff', // antenna bulbs — the logo's "84" magenta
  R: '#ee4444', A: '#eeaa44', N: '#44dd44', C: '#44eeee', // logo stripe
};

const HEAD = [
  '..MM........MM..',
  '..MM........MM..',
  '...K........K...',
  '....KKKKKKKK....',
  '..KKTVVTTTTTKK..',
  '.KTTTTTTTTTTTTK.',
  '.KTWWWTTTTWWWTK.',
  'KTTWKKTTTTWKKTTK',
  'KTTWKKTTTTWKKTTK',
  'KTPPTTTTTTTTPPTK',
  'KTTTTKTTTTKTTTTK',
  'KTTTTTKKKKTTTTTK',
  '.KTTTTTTTTTTTTK.',
  '.KUTTTTTTTTTTUK.',
  '..KKUUUUUUUUKK..',
  '....KKKKKKKK....',
];

const BODY = [
  '........KDDK........',
  '....KKKKKKKKKKKK....',
  '..KKTTTTTTTTTTTTKK..',
  '.KUKTKKKKKKKKKKTKUK.',
  '.KUKTKRRAANNCCKTKUK.',
  '.KUKTKSSSSSSMSKTKUK.',
  '.KUKTKKKKKKKKKKTKUK.',
  'KLLKTTTTTTTTTTTTKLLK',
  '.KK.KUUUUUUUUUUK.KK.',
  '....KKKKKKKKKKKK....',
  '......KDK..KDK......',
  '.....KKKK..KKKK.....',
];

const FULL = [...HEAD.map(r => `..${r}..`), ...BODY];

for (const [name, rows, w] of [['HEAD', HEAD, 16], ['FULL', FULL, 20]] as const) {
  rows.forEach((r, i) => {
    if (r.length !== w) throw new Error(`${name} row ${i} is ${r.length} wide, expected ${w}`);
    for (const c of r) if (c !== '.' && !PAL[c]) throw new Error(`${name} row ${i}: unknown colour '${c}'`);
  });
}

/** Grid → SVG, merging horizontal runs of one colour into a single rect. */
function svg(rows: readonly string[]): string {
  const w = rows[0].length, h = rows.length;
  let rects = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < w;) {
      const c = row[x];
      let e = x + 1;
      while (e < w && row[e] === c) e++;
      if (c !== '.') rects += `<rect x="${x}" y="${y}" width="${e - x}" height="1" fill="${PAL[c]}"/>`;
      x = e;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${rects}</svg>\n`;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Grid → RGBA PNG at `scale` px per cell, centred on a `size`² canvas. */
function png(rows: readonly string[], scale: number, size: number, bg?: string): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  if (bg) {
    const [r, g, b] = hex(bg);
    for (let i = 0; i < size * size; i++) rgba.set([r, g, b, 255], i * 4);
  }
  const ox = (size - rows[0].length * scale) >> 1, oy = (size - rows.length * scale) >> 1;
  rows.forEach((row, gy) => [...row].forEach((c, gx) => {
    if (c === '.') return;
    const [r, g, b] = hex(PAL[c]);
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      rgba.set([r, g, b, 255], ((oy + gy * scale + y) * size + ox + gx * scale + x) * 4);
    }
  }));
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG-in-ICO container (supported by every browser since IE Vista-era). */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header[e] = size & 255; // 256 encodes as 0
    header[e + 1] = size & 255;
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bpp
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(i => i.data)]);
}

const out = join(import.meta.dirname, '..', 'public');
writeFileSync(join(out, 'favicon.svg'), svg(HEAD));
writeFileSync(join(out, 'mascot.svg'), svg(FULL));
writeFileSync(join(out, 'favicon.ico'), ico([1, 2, 3].map(s => ({ size: 16 * s, data: png(HEAD, s, 16 * s) }))));
writeFileSync(join(out, 'apple-touch-icon.png'), png(HEAD, 10, 180, '#555566'));
console.log(`Blip written to ${out}`);
