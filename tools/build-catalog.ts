/**
 * build-catalog.ts — generate the ZX84 game-library catalog from the local
 * SQLite copy of ZXDB. This is the second of two commands:
 *
 *   npm run catalog:db      # fetch-zxdb.ts: GitHub → tools/zxdb.sqlite
 *   npm run catalog:json    # this script:   tools/zxdb.sqlite → catalog.json(.gz)
 *   npm run deploy:catalog  # upload catalog.json.gz to R2 (zx84/library/)
 *
 * Reads the SQLite via Node's built-in `node:sqlite` (Node ≥ 22.5) — no runtime
 * or build dependencies. Point at a different DB with `--file`.
 *
 * Output: tools/out/catalog.json and tools/out/catalog.json.gz, plus a printed
 * size/row summary. `deploy:catalog` then publishes it to the host referenced by
 * DEFAULT_CATALOG_URL in src/library/catalog.ts.
 *
 * Scope: ZX-Spectrum entries marked Available that have a playable tape
 * (.tzx/.tap) or disk (.dsk) download, excluding x-rated entries
 * (entries.is_xrated). Books/hardware/magazines fall out naturally — they have
 * no such download. The compact schema matches
 * RawCatalog/RawGame in src/library/catalog.ts (short keys; genre & publisher
 * are indices into shared dictionaries).
 */

import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── CLI config ────────────────────────────────────────────────────────────

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// Default: the SQLite that `npm run catalog:db` writes next to this script.
const DB_FILE = resolve(HERE, arg('file', 'zxdb.sqlite'));
// Which machine family to include (matched with SQL LIKE against machinetypes.text).
const MACHINE_LIKE = arg('machine', 'ZX-Spectrum%');
const OUT_DIR = resolve(HERE, 'out');

// ── Row shapes ────────────────────────────────────────────────────────────

interface MetaRow { id: number; title: string; year: number | null; genre: string | null; publisher: string | null; }
interface DownRow { id: number; link: string; ft: number; }

// Compact output schema — keep in sync with src/library/catalog.ts.
interface RawGame { t: string; y?: number; g?: number; p?: number; f?: string; d?: string; s?: string; }
interface RawCatalog { genres: string[]; publishers: string[]; games: RawGame[]; }

function main(): void {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });

  // Pre-flight: show the machine types we're matching so the operator can sanity
  // check the LIKE filter (ZXDB has many Spectrum variants plus ZX80/81/SAM/etc).
  const machines = db.prepare('SELECT text FROM machinetypes WHERE text LIKE ? ORDER BY id').all(MACHINE_LIKE) as { text: string }[];
  console.log(`machinetypes matching "${MACHINE_LIKE}": ${machines.map(m => m.text).join(', ') || '(none!)'}`);

  // Entry metadata: original release (release_seq 0), first publisher, genre.
  const meta = db.prepare(
    `SELECT e.id AS id, e.title AS title, r.release_year AS year,
            g.text AS genre, l.name AS publisher
       FROM entries e
       JOIN machinetypes m   ON m.id = e.machinetype_id AND m.text LIKE ?
  LEFT JOIN releases r        ON r.entry_id = e.id AND r.release_seq = 0
  LEFT JOIN publishers p      ON p.entry_id = e.id AND p.release_seq = 0 AND p.publisher_seq = 1
  LEFT JOIN labels l          ON l.id = p.label_id
  LEFT JOIN genretypes g      ON g.id = e.genretype_id
      WHERE e.availabletype_id = 'A'
        AND e.is_xrated = 0`,
  ).all(MACHINE_LIKE) as unknown as MetaRow[];

  // Candidate downloads: tape images (filetype 8: .tzx/.tap), disk images
  // (filetype 11: .dsk), and SCR screens (filetype 1 = loading, 2 = running).
  // SQLite has no built-in REGEXP, so match by suffix with LOWER()+LIKE. One
  // entry may have several — we dedupe in JS below.
  const downs = db.prepare(
    `SELECT d.entry_id AS id, d.file_link AS link, d.filetype_id AS ft
       FROM downloads d
       JOIN entries e        ON e.id = d.entry_id
       JOIN machinetypes m   ON m.id = e.machinetype_id AND m.text LIKE ?
      WHERE e.availabletype_id = 'A'
        AND ( (d.filetype_id = 8  AND (LOWER(d.file_link) LIKE '%.tzx.zip' OR LOWER(d.file_link) LIKE '%.tap.zip'))
           OR (d.filetype_id = 11 AND LOWER(d.file_link) LIKE '%.dsk.zip')
           OR (d.filetype_id IN (1, 2) AND LOWER(d.file_link) LIKE '%.scr') )`,
  ).all(MACHINE_LIKE) as unknown as DownRow[];

  db.close();

  // Pick one tape (prefer .tzx over .tap), one disk, and one SCR screen
  // (prefer a loading screen, filetype 1, over a running screen, filetype 2).
  const files = new Map<number, { tape?: string; disk?: string; screen?: string; screenFt?: number }>();
  for (const d of downs) {
    const slot = files.get(d.id) ?? {};
    if (d.ft === 11) {
      if (!slot.disk) slot.disk = d.link;
    } else if (d.ft === 1 || d.ft === 2) {
      if (!slot.screen || (d.ft === 1 && slot.screenFt !== 1)) { slot.screen = d.link; slot.screenFt = d.ft; }
    } else {
      const isTzx = /\.tzx\.zip$/i.test(d.link);
      // Prefer a .tzx; otherwise take the first tape seen.
      if (!slot.tape || (isTzx && !/\.tzx\.zip$/i.test(slot.tape))) slot.tape = d.link;
    }
    files.set(d.id, slot);
  }

  // Dictionaries for genre/publisher → small integer indices.
  const genres: string[] = [];
  const publishers: string[] = [];
  const genreIdx = new Map<string, number>();
  const pubIdx = new Map<string, number>();
  const intern = (val: string | null, list: string[], idx: Map<string, number>): number | undefined => {
    if (!val) return undefined;
    let i = idx.get(val);
    if (i === undefined) { i = list.length; list.push(val); idx.set(val, i); }
    return i;
  };

  const games: RawGame[] = [];
  for (const row of meta) {
    const f = files.get(row.id);
    if (!f || (!f.tape && !f.disk)) continue;   // no playable file → skip
    const g: RawGame = { t: row.title };
    if (row.year) g.y = row.year;
    const gi = intern(row.genre, genres, genreIdx);
    if (gi !== undefined) g.g = gi;
    const pi = intern(row.publisher, publishers, pubIdx);
    if (pi !== undefined) g.p = pi;
    if (f.tape) g.f = f.tape;
    if (f.disk) g.d = f.disk;
    if (f.screen) g.s = f.screen;
    games.push(g);
  }

  // Stable order: alphabetical by title for predictable diffs / a nicer default list.
  games.sort((a, b) => a.t.localeCompare(b.t));

  const catalog: RawCatalog = { genres, publishers, games };
  const json = JSON.stringify(catalog);
  const gz = gzipSync(Buffer.from(json), { level: 9 });

  // Content hash → clients fetch the tiny version file each load and only
  // re-download the catalog when this changes (see fetchCatalog in catalog.ts).
  const version = createHash('sha256').update(json).digest('hex').slice(0, 12);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'catalog.json'), json);
  writeFileSync(resolve(OUT_DIR, 'catalog.json.gz'), gz);
  writeFileSync(resolve(OUT_DIR, 'catalog-version.json'), JSON.stringify({ version }));

  const mb = (n: number) => (n / 1024 / 1024).toFixed(2);
  console.log(`games:      ${games.length}`);
  console.log(`with screen:${games.filter(g => g.s).length}`);
  console.log(`genres:     ${genres.length}   publishers: ${publishers.length}`);
  console.log(`raw JSON:   ${mb(json.length)} MB`);
  console.log(`gzipped:    ${mb(gz.length)} MB`);
  console.log(`version:    ${version}`);
  console.log(`written to: ${OUT_DIR}`);
  console.log('next: npm run deploy:catalog  (uploads catalog.json.gz + catalog-version.json to R2)');
  // Decision gate (see plan): if gzip is much over ~3 MB, prefer the Worker+D1
  // search endpoint (Option B) over shipping this as a static file.
}

main();
