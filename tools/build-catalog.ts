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
import { dirname, resolve, basename } from 'node:path';
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
interface DownRow { id: number; link: string; ft: number; mt: number | null; rel: number | null; lang: string | null; }

// Compact output schema — keep in sync with src/library/catalog.ts. Model is
// implicit in which slot a file lands in: f ⇒ 48K, k ⇒ 128K, d/ds ⇒ +3 (disk),
// n ⇒ 48K snapshot, nk ⇒ 128K snapshot. Snapshots are a fallback, emitted only
// for entries with no tape and no disk; they mount directly (no loader).
interface RawGame {
  i: number;                  // ZXDB entry id
  t: string;
  y?: number; g?: number; p?: number; s?: string;
  f?: string;                 // 48K tape (.tzx preferred)
  k?: string;                 // 128K tape
  d?: string;                 // disk (side A / disk 1 when multi-side)
  ds?: [string, string][];    // extra disk sides: [file_link, label]
  n?: string;                 // 48K snapshot (.szx > .z80 > .sna)
  nk?: string;                // 128K snapshot
}
interface RawCatalog { genres: string[]; publishers: string[]; games: RawGame[]; }

/**
 * 48K vs 128K bucket for a tape, from its machinetype_id. The "48K/128K" dual
 * (4), 128K (5), +2 (7) and the rarer +2A/+3 tapes (8–10) plus Next (27) all go
 * in the 128 bucket — they want, or at least tolerate, a 128K-class machine.
 * 16K/48K/untagged stay 48.
 */
function tapeBucket(mt: number | null | undefined): '48' | '128' {
  switch (mt) {
    case 4: case 5: case 7: case 8: case 9: case 10: case 27: return '128';
    default: return '48';
  }
}

// Snapshot format preference: .szx (3) > .z80 (2) > .sna (1); 0 = not a snapshot.
function snapRank(link: string): number {
  const l = link.toLowerCase();
  if (/\.szx(\.zip)?$/.test(l)) return 3;
  if (/\.z80(\.zip)?$/.test(l)) return 2;
  if (/\.sna(\.zip)?$/.test(l)) return 1;
  return 0;
}

// A disk filename denoting a distinct side/part to KEEP (e.g. "(SideA)",
// "(Disk1SideB)") — as opposed to a fix/alt re-dump to drop.
const DISK_PART = /\([^)]*(side\s*[ab12]|disk\s*[ab12]|disc\s*[ab12]|part\s*[12])[^)]*\)/i;
// Re-dump / variant markers: drop these when collapsing to one logical disk.
const DISK_ALT = /\((fixed|alt|crack|lightgun|trainer)|_\d+\.dsk\.zip$/i;

/** Human label for a side/part disk, derived from its filename parenthetical:
 *  "(SideA)" → "Side A", "(Disk1SideB)" → "Disk 1 Side B". */
function partLabel(base: string): string {
  const m = base.match(/\(([^)]*(?:side|disk|disc|part)[^)]*)\)/i);
  if (!m) return 'Disk';
  return m[1]
    .replace(/(side|disk|disc|part)/gi, w => ` ${w[0].toUpperCase()}${w.slice(1).toLowerCase()} `)
    .replace(/([a-z])(\d)/gi, '$1 $2').replace(/(\d)([a-z])/gi, '$1 $2')
    .replace(/\s+/g, ' ').trim();
}

/** Collapse an entry's disk links into a primary `d` plus any extra `ds` sides.
 *  Prefer English disks, then the original release (lowest release_seq) so budget
 *  re-issues don't win; then ≥2 side/part files ⇒ a multi-side set (keep all,
 *  labelled), otherwise one logical disk — prefer the cleanest dump over
 *  (fixed)/_2/(alt) re-dumps. */
function resolveDisks(all: { link: string; rel: number; en: boolean }[]): { d?: string; ds?: [string, string][] } {
  if (all.length === 0) return {};
  const pool = all.some(x => x.en) ? all.filter(x => x.en) : all;
  const minRel = Math.min(...pool.map(x => x.rel));
  const disks = pool.filter(x => x.rel === minRel).map(x => x.link);
  const parts = disks.filter(l => DISK_PART.test(basename(l)));
  if (parts.length >= 2) {
    const labelled = parts
      .map(l => [l, partLabel(basename(l))] as [string, string])
      .sort((a, b) => a[1].localeCompare(b[1]));
    const [first, ...rest] = labelled;
    return { d: first[0], ds: rest.length ? rest : undefined };
  }
  const clean = disks.filter(l => !DISK_ALT.test(basename(l)));
  const pick = (clean.length ? clean : disks).sort((a, b) => basename(a).length - basename(b).length)[0];
  return { d: pick };
}

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
    `SELECT d.entry_id AS id, d.file_link AS link, d.filetype_id AS ft, d.machinetype_id AS mt, d.release_seq AS rel, d.language_id AS lang
       FROM downloads d
       JOIN entries e        ON e.id = d.entry_id
       JOIN machinetypes m   ON m.id = e.machinetype_id AND m.text LIKE ?
      WHERE e.availabletype_id = 'A'
        AND ( (d.filetype_id = 8  AND (LOWER(d.file_link) LIKE '%.tzx.zip' OR LOWER(d.file_link) LIKE '%.tap.zip'))
           OR (d.filetype_id = 11 AND LOWER(d.file_link) LIKE '%.dsk.zip')
           OR (d.filetype_id IN (1, 2) AND LOWER(d.file_link) LIKE '%.scr')
           OR LOWER(d.file_link) LIKE '%.szx' OR LOWER(d.file_link) LIKE '%.szx.zip'
           OR LOWER(d.file_link) LIKE '%.z80' OR LOWER(d.file_link) LIKE '%.z80.zip'
           OR LOWER(d.file_link) LIKE '%.sna' OR LOWER(d.file_link) LIKE '%.sna.zip' )`,
  ).all(MACHINE_LIKE) as unknown as DownRow[];

  db.close();

  // Per entry: best 48K/128K tape (each prefers .tzx over .tap), all disk links
  // (resolved to a primary + sides later), best 48K/128K snapshot (.szx>.z80>
  // .sna), and one SCR screen (prefer a loading screen, ft 1, over running, 2).
  // Classify by file extension — snapshots share no single filetype_id.
  // Selection priority for each slot: English first, then the ORIGINAL release
  // (lowest release_seq) over budget re-issues (Erbe, Mastertronic, …), then the
  // per-media format rank (.tzx>.tap for tapes, .szx>.z80>.sna for snapshots).
  // Untagged release_seq sorts last; only language_id 'en' counts as English.
  interface Pick { link: string; en: boolean; rel: number; rank: number; }
  interface Slot {
    tape48?: Pick; tape128?: Pick; disks: { link: string; rel: number; en: boolean }[];
    snap48?: Pick; snap128?: Pick;
    screen?: string; screenFt?: number;
  }
  const better = (en: boolean, rel: number, rank: number, cur?: Pick) => {
    if (!cur) return true;
    if (en !== cur.en) return en;          // English beats non-English
    if (rel !== cur.rel) return rel < cur.rel;  // then the original release
    return rank > cur.rank;                // then the better format
  };

  const files = new Map<number, Slot>();
  for (const d of downs) {
    let slot = files.get(d.id);
    if (!slot) { slot = { disks: [] }; files.set(d.id, slot); }
    const l = d.link.toLowerCase();
    const rel = d.rel ?? 999;
    const en = d.lang === 'en';
    const snap = snapRank(l);
    const b = tapeBucket(d.mt);
    if (l.endsWith('.dsk.zip')) {
      slot.disks.push({ link: d.link, rel, en });
    } else if (l.endsWith('.tzx.zip') || l.endsWith('.tap.zip')) {
      const rank = l.endsWith('.tzx.zip') ? 1 : 0;
      const cur = b === '128' ? slot.tape128 : slot.tape48;
      if (better(en, rel, rank, cur)) {
        const t = { link: d.link, en, rel, rank };
        if (b === '128') slot.tape128 = t; else slot.tape48 = t;
      }
    } else if (snap > 0) {
      const cur = b === '128' ? slot.snap128 : slot.snap48;
      if (better(en, rel, snap, cur)) {
        const s = { link: d.link, en, rel, rank: snap };
        if (b === '128') slot.snap128 = s; else slot.snap48 = s;
      }
    } else if (d.ft === 1 || d.ft === 2) {
      if (!slot.screen || (d.ft === 1 && slot.screenFt !== 1)) { slot.screen = d.link; slot.screenFt = d.ft; }
    }
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
    if (!f) continue;
    const { d, ds } = resolveDisks(f.disks);
    const hasTapeOrDisk = !!(f.tape48 || f.tape128 || d);
    // Snapshots are a fallback only — skipped entirely when a tape/disk exists.
    const hasSnap = !!(f.snap48 || f.snap128);
    if (!hasTapeOrDisk && !hasSnap) continue;      // no playable file → skip
    const g: RawGame = { i: row.id, t: row.title };
    if (row.year) g.y = row.year;
    const gi = intern(row.genre, genres, genreIdx);
    if (gi !== undefined) g.g = gi;
    const pi = intern(row.publisher, publishers, pubIdx);
    if (pi !== undefined) g.p = pi;
    if (f.tape48) g.f = f.tape48.link;
    if (f.tape128) g.k = f.tape128.link;
    if (d) g.d = d;
    if (ds) g.ds = ds;
    if (!hasTapeOrDisk) {
      if (f.snap48) g.n = f.snap48.link;
      if (f.snap128) g.nk = f.snap128.link;
    }
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
  console.log(`tapes 48/128: ${games.filter(g => g.f).length} / ${games.filter(g => g.k).length}   disks: ${games.filter(g => g.d).length}   multi-side: ${games.filter(g => g.ds).length}`);
  console.log(`snapshot-only 48/128: ${games.filter(g => g.n).length} / ${games.filter(g => g.nk).length}`);
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
