/**
 * build-sam-catalog.ts — the SAM Coupé half of the ZXDB-backed software browser.
 *
 *   npm run catalog:db      # fetch-zxdb.ts: GitHub → tools/zxdb.sqlite
 *   npm run catalog:sam     # this script:   tools/zxdb.sqlite → sam-catalog.json(.gz)
 *   npm run deploy:catalog  # upload to R2 (zx84/library/)
 *
 * Scope: ZXDB machinetype 16 ("SAM Coupé"), entries marked Available and not
 * x-rated, that have a disk or tape download. That is ~200 titles — the whole
 * of ZXDB's SAM holdings that can actually be booted.
 *
 * Media, and why:
 *   - `.mgt.zip` / `.dsk.zip` are both raw 819,200-byte MGT dumps. On the SAM
 *     `.dsk` does NOT mean the CPC/+3 container it means everywhere else in
 *     zx84, so the client decides by content — see `parseSamMedia`.
 *   - `.tap.zip` / `.tzx.zip` for the handful of tape-only releases.
 *   - `.sad.zip` is deliberately skipped: the SAM media service refuses SAD
 *     rather than guessing at it, so shipping one would be a dead entry.
 *
 * Screens are SimCoupe screen dumps — `.ssx`, `.ss4`, and `.scr`, which on a
 * SAM entry is the same thing under a Spectrum-looking name (6928 bytes: a
 * mode 1 screen plus its CLUT, where a Spectrum .scr is 6912 and has none).
 * All three decode through `src/machines/sam/ssx.ts`; a scattering of entries
 * carry an ordinary raster image instead.
 *
 * Every candidate is published, best first, because the best one is not
 * guaranteed to be *fetchable*: the file host serves some of these extensions
 * and not others, and a viewer that tries only the top pick shows nothing when
 * that is the one missing.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_FILE = resolve(HERE, 'zxdb.sqlite');
const OUT = resolve(HERE, 'out');

/** ZXDB's machinetype id for the SAM Coupé. */
const SAM_MACHINETYPE = 16;

interface MetaRow {
  id: number; title: string; year: number | null;
  genre: string | null; publisher: string | null;
}
interface FileRow { id: number; link: string; ft: number; rel: number | null; lang: string | null; }

/** Compact output schema — keep in sync with RawSamGame in
 *  `src/library/sam-catalog.ts`. */
interface RawGame {
  i: number;                  // ZXDB entry id
  t: string;                  // title
  y?: number;                 // year
  g?: number;                 // index into `genres`
  p?: number;                 // index into `publishers`
  d?: string;                 // first disk
  ds?: [string, string][];    // further disks: [file_link, label]
  f?: string;                 // tape
  s?: string;                 // screenshot
  sx?: string[];              // further screenshots, in preference order
}

/** How many runner-up screens to publish. Enough to survive a gap in the file
 *  host without bloating a catalog nobody reads that far into. */
const MAX_EXTRA_SCREENS = 3;

const DISK = /\.(mgt|dsk)\.zip$/i;
const TAPE = /\.(tzx|tap)\.zip$/i;
const NATIVE_SCREEN = /\.(ssx|ss4|scr)$/i;
const RASTER_SCREEN = /\.(gif|png|jpe?g)$/i;

/**
 * The stem a disk belongs to, ignoring format and any `(N)` suffix.
 *
 * On this data a parenthesised numeral marks ANOTHER DUMP of the same disk,
 * not the next disk of a set: `SAMDOS(2)`, `Defender(2)` and `Tetris(3)` are
 * all single-disk titles. Real multi-disk releases here are the disk magazines,
 * which letter their disks into the stem itself — `FRED11A`, `FRED11B` — so
 * those stay separate and are kept as a set. This is the same call the Spectrum
 * builder makes with its `(fixed)`/`(alt)`/`_2` re-dumps.
 */
function diskStem(link: string): string {
  return basename(link).replace(DISK, '').replace(/\(\d+\)$/, '').toLowerCase();
}

/** Order two dumps of one disk: preferred format, then the original release,
 *  then the plain name over its `(2)`/`(3)` re-dumps. */
function betterDump(a: FileRow, b: FileRow): number {
  return diskRank(a.link) - diskRank(b.link)
    || byRelease(a, b)
    || basename(a.link).length - basename(b.link).length
    || basename(a.link).localeCompare(basename(b.link));
}

/** Prefer `.mgt` over `.dsk` for the same content: both are raw MGT dumps, and
 *  a couple of entries carry the identical disk under each name. */
function diskRank(link: string): number {
  return /\.mgt\.zip$/i.test(link) ? 0 : 1;
}

/** Prefer `.tzx` over `.tap` — it preserves the loader's timing. */
function tapeRank(link: string): number {
  return /\.tzx\.zip$/i.test(link) ? 0 : 1;
}

/** English first, then the original release over later re-issues. */
function byRelease(a: FileRow, b: FileRow): number {
  const english = Number(b.lang === 'en') - Number(a.lang === 'en');
  if (english) return english;
  return (a.rel ?? 999) - (b.rel ?? 999);
}

/**
 * Screen preference: a loading screen (filetype 1) says most about a title,
 * then filetype 3, then an in-game grab (2). Within a filetype a raster image
 * comes first because it cannot fail to display, then `.scr`, then the other
 * native dumps — an order that costs nothing when every file is reachable and
 * puts the reachable ones first when they are not.
 */
function screenScore(file: FileRow): number {
  const stage = file.ft === 1 ? 0 : file.ft === 3 ? 1 : 2;
  const format = RASTER_SCREEN.test(file.link) ? 0 : /\.scr$/i.test(file.link) ? 1 : 2;
  return stage * 3 + format;
}

function main(): void {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  const meta = db.prepare(
    `SELECT e.id, e.title, r.release_year AS year, g.text AS genre, l.name AS publisher
       FROM entries e
  LEFT JOIN releases r   ON r.entry_id = e.id AND r.release_seq = 0
  LEFT JOIN publishers p ON p.entry_id = e.id AND p.release_seq = 0 AND p.publisher_seq = 1
  LEFT JOIN labels l     ON l.id = p.label_id
  LEFT JOIN genretypes g ON g.id = e.genretype_id
      WHERE e.machinetype_id = ? AND e.availabletype_id = 'A' AND e.is_xrated = 0`,
  ).all(SAM_MACHINETYPE) as unknown as MetaRow[];

  const files = db.prepare(
    `SELECT d.entry_id AS id, d.file_link AS link, d.filetype_id AS ft,
            d.release_seq AS rel, d.language_id AS lang
       FROM downloads d
       JOIN entries e ON e.id = d.entry_id
      WHERE e.machinetype_id = ? AND e.availabletype_id = 'A'`,
  ).all(SAM_MACHINETYPE) as unknown as FileRow[];
  db.close();

  const byEntry = new Map<number, FileRow[]>();
  for (const file of files) {
    const list = byEntry.get(file.id) ?? [];
    list.push(file);
    byEntry.set(file.id, list);
  }

  const genres: string[] = [];
  const publishers: string[] = [];
  const genreIndex = new Map<string, number>();
  const publisherIndex = new Map<string, number>();
  const intern = (value: string | null, values: string[], index: Map<string, number>): number | undefined => {
    if (!value) return undefined;
    const known = index.get(value);
    if (known !== undefined) return known;
    const next = values.length;
    values.push(value);
    index.set(value, next);
    return next;
  };

  const games: RawGame[] = [];
  for (const row of meta) {
    const candidates = byEntry.get(row.id) ?? [];

    // One entry per physical disk: collapse the format duplicates first, then
    // order what is left and treat it as the set.
    const bestPerStem = new Map<string, FileRow>();
    for (const file of candidates.filter(f => DISK.test(f.link))) {
      const stem = diskStem(file.link);
      const held = bestPerStem.get(stem);
      if (!held || betterDump(file, held) < 0) bestPerStem.set(stem, file);
    }
    const disks = [...bestPerStem.values()]
      .sort((a, b) => basename(a.link).localeCompare(basename(b.link)));

    const tapes = candidates.filter(f => TAPE.test(f.link))
      .sort((a, b) => byRelease(a, b) || tapeRank(a.link) - tapeRank(b.link));

    if (!disks.length && !tapes.length) continue;   // nothing bootable

    const screens = candidates
      .filter(f => (f.ft === 1 || f.ft === 2 || f.ft === 3)
        && (NATIVE_SCREEN.test(f.link) || RASTER_SCREEN.test(f.link)))
      .sort((a, b) => screenScore(a) - screenScore(b));

    const game: RawGame = { i: row.id, t: row.title };
    if (row.year) game.y = row.year;
    const genre = intern(row.genre, genres, genreIndex);
    const publisher = intern(row.publisher, publishers, publisherIndex);
    if (genre !== undefined) game.g = genre;
    if (publisher !== undefined) game.p = publisher;
    if (disks.length) {
      game.d = disks[0].link;
      const extra = disks.slice(1);
      if (extra.length) {
        game.ds = extra.map((file, i) => [file.link, `Disk ${i + 2}`] as [string, string]);
      }
    }
    if (tapes.length) game.f = tapes[0].link;
    if (screens.length) {
      const links = [...new Set(screens.map(s => s.link))];
      game.s = links[0];
      const extra = links.slice(1, 1 + MAX_EXTRA_SCREENS);
      if (extra.length) game.sx = extra;
    }
    games.push(game);
  }
  games.sort((a, b) => a.t.localeCompare(b.t));

  const json = JSON.stringify({ genres, publishers, games });
  const version = createHash('sha256').update(json).digest('hex').slice(0, 12);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'sam-catalog.json'), json);
  writeFileSync(resolve(OUT, 'sam-catalog.json.gz'), gzipSync(Buffer.from(json), { level: 9 }));
  writeFileSync(resolve(OUT, 'sam-catalog-version.json'), JSON.stringify({ version }));

  const withDisk = games.filter(g => g.d).length;
  const multi = games.filter(g => g.ds).length;
  console.log(
    `SAM Coupé titles: ${games.length} (${withDisk} disk, ${games.length - withDisk} tape-only, `
    + `${multi} multi-disk, ${games.filter(g => g.s).length} with a screen); version: ${version}`);
}

main();
