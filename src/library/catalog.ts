/**
 * Game library catalog — types, upstream URL reconstruction, and the
 * fetch/decompress/cache of the ZXDB-derived catalog.
 *
 * The catalog is built offline by `tools/build-catalog.ts` from a local ZXDB
 * MariaDB instance and hosted as a gzipped JSON. The app fetches it once,
 * caches the raw bytes in IndexedDB, and decodes on demand. Game *binaries*
 * are not bundled — each entry stores a ZXDB `file_link` that
 * `reconstructUrl()` turns into an upstream download URL fetched on play.
 */

import { dbLoad, dbSave, getSaved, setSaved } from '@/store/persistence.ts';
import { is128kClass, isPlus3, type SpectrumModel, type MachineModel } from '@/models.ts';

/** One game in the compact on-wire schema. Short keys keep the JSON small. The
 *  required model is implicit in which slot a file lands in: f ⇒ 48K tape,
 *  k ⇒ 128K tape, d/ds ⇒ +3 disk, n ⇒ 48K snapshot, nk ⇒ 128K snapshot,
 *  r ⇒ ZX Interface 2 ROM cartridge (16K/48K only).
 *  Snapshots are a fallback emitted only when the game has no tape and no disk;
 *  they mount directly (no loader). A ROM cartridge, when present, takes
 *  priority over every other slot — see planLoad()/gameNeeds(). */
export interface RawGame {
  i: number;    // ZXDB entry id
  t: string;    // title
  y?: number;   // release year
  g?: number;   // genre — index into RawCatalog.genres
  p?: number;   // publisher — index into RawCatalog.publishers
  s?: string;   // running-screen image file_link (.scr)
  f?: string;   // 48K tape file_link (.tzx preferred, else .tap)
  k?: string;   // 128K tape file_link
  d?: string;   // disk file_link (.dsk) — side A / disk 1
  ds?: [string, string][]; // extra disk sides: [file_link, label]
  n?: string;   // 48K snapshot file_link (.szx/.z80/.sna), fallback only
  nk?: string;  // 128K snapshot file_link, fallback only
  r?: string;   // ZX Interface 2 ROM cartridge file_link (.rom), 16K/48K only
}

export interface RawCatalog {
  genres: string[];
  publishers: string[];
  games: RawGame[];
}

/** A catalog entry resolved for the UI (dictionary indices expanded). */
export interface Game {
  /** ZXDB entry id — stable key. */
  id: number;
  title: string;
  year: number | null;
  genre: string;
  publisher: string;
  /** ZXDB file_link for the 48K tape, '' when none. */
  tape48: string;
  /** ZXDB file_link for the 128K tape, '' when none. */
  tape128: string;
  /** ZXDB file_link for the primary disk side, '' when none. */
  disk: string;
  /** Extra disk sides: [file_link, label]. */
  diskSides: [string, string][];
  /** True when the game has only a disk (no tape) — forces a +3. */
  isDiskOnly: boolean;
  /** ZXDB file_link for a 48K snapshot, '' when none. Fallback when there's no
   *  tape/disk; mounts directly. */
  snap48: string;
  /** ZXDB file_link for a 128K snapshot, '' when none. */
  snap128: string;
  /** ZXDB file_link for a running-screen image ('' when none). */
  screen: string;
  /** ZXDB file_link for a ZX Interface 2 ROM cartridge, '' when none (16K/48K
   *  only). Takes priority over every other slot when present. */
  rom: string;
}

// Game files are tried CDN-first, Worker-second:
//   1. R2_PUBLIC_BASE — the R2 public domain. Hits cached files straight off the
//      CDN (fast, no Worker). 404 if not cached yet.
//   2. FILE_PROXY_BASE — the standalone `zxfileserver` Worker, which fetches the
//      file from Spectrum Computing, stores it in R2, and streams it back with
//      CORS. After this first warm-up the CDN copy exists, so later loads hit #1.
// We can't fetch the upstream hosts directly: archive.org's WoS mirror is a giant
// zip behind a 503-prone extractor, and spectrumcomputing.co.uk sends no CORS.
//
// Files live under the bucket's `library/` prefix; the ZXDB `file_link`
// (e.g. "/pub/…" or "/zxdb/…") is appended to each base.
const R2_PUBLIC_BASE = 'https://zx84files.bitsparse.com/library';
const FILE_PROXY_BASE = 'https://zxfileserver.envytech.workers.dev';

/**
 * Ordered candidate URLs for a game file: the CDN copy first, then the Worker
 * (which populates the CDN on a miss). Empty for a missing link; an absolute
 * http(s) link is returned as the sole candidate.
 */
export function fileUrls(fileLink: string | undefined | null): string[] {
  if (!fileLink) return [];
  if (/^https?:\/\//i.test(fileLink)) return [fileLink];
  const path = fileLink.startsWith('/') ? fileLink : `/${fileLink}`;
  return [R2_PUBLIC_BASE + path, FILE_PROXY_BASE + path];
}

/** Basename of a file_link, e.g. "/pub/…/ManicMiner.tzx.zip" → "ManicMiner.tzx.zip". */
export function basename(fileLink: string): string {
  const slash = fileLink.lastIndexOf('/');
  return slash >= 0 ? fileLink.slice(slash + 1) : fileLink;
}

// Trailing company/legal suffixes to drop for the compact publisher label. ZXDB
// has no short-name field, so we trim these at display time (the full name is
// kept in the catalog + row tooltip). Add Software|Computers?|Computing|
// Entertainment|Productions?|Studios?|Systems? here for a tighter "Strategy B".
const PUBLISHER_SUFFIX = /[,\s]+(Ltd\.?|Limited|Inc\.?|PLC|S\.?A\.?|S\.?L\.?|GmbH|B\.?V\.?|Co\.?|Corp\.?|Corporation|Pty\.?)$/i;

/** Parsed search box: positive `text` (title substring) plus `negTerms` (title
 *  substrings to EXCLUDE — any word prefixed with `-`, e.g. `-demo`), and the
 *  `year:` / `publisher:` tokens pulled out for structured filtering. All
 *  lower-cased. The year filter is inclusive — `year:1987` sets both bounds to
 *  1987; `year:1983-1989` spans the range (both bounds required). */
export interface LibraryQuery {
  text: string;
  negTerms: string[];
  yearMin: number | null;
  yearMax: number | null;
  publisher: string;
}

export function parseLibraryQuery(q: string): LibraryQuery {
  let yearMin: number | null = null;
  let yearMax: number | null = null;
  let publisher = '';
  const text: string[] = [];
  const negTerms: string[] = [];
  for (const tok of q.trim().split(/\s+/)) {
    if (!tok) continue;
    const lower = tok.toLowerCase();
    if (lower.length > 1 && lower.startsWith('-')) {
      // -word → exclude titles containing "word".
      negTerms.push(lower.slice(1));
    } else if (lower.startsWith('year:')) {
      const v = lower.slice(5);
      const range = v.match(/^(\d{1,4})-(\d{1,4})$/);
      if (range) {
        let lo = parseInt(range[1], 10);
        let hi = parseInt(range[2], 10);
        if (lo > hi) [lo, hi] = [hi, lo];
        yearMin = lo;
        yearMax = hi;
      } else if (/^\d{1,4}$/.test(v)) {
        yearMin = yearMax = parseInt(v, 10);
      }
    } else if (lower.startsWith('publisher:')) {
      publisher = lower.slice('publisher:'.length);
    } else {
      text.push(lower);
    }
  }
  return { text: text.join(' '), negTerms, yearMin, yearMax, publisher };
}

/** Short publisher label: "Ocean Software Ltd" → "Ocean Software", "Domark Ltd"
 *  → "Domark". Never returns empty (falls back to the original name). */
export function shortPublisher(name: string): string {
  let s = name;
  let prev = '';
  while (s !== prev && s.length > 2) { prev = s; s = s.replace(PUBLISHER_SUFFIX, '').trim(); }
  return s || name;
}

/** Resolve a compact RawGame against the catalog dictionaries for display. */
export function resolveGame(raw: RawGame, cat: RawCatalog): Game {
  return {
    id: raw.i,
    title: raw.t,
    year: raw.y ?? null,
    genre: raw.g != null ? cat.genres[raw.g] ?? '' : '',
    publisher: raw.p != null ? cat.publishers[raw.p] ?? '' : '',
    tape48: raw.f ?? '',
    tape128: raw.k ?? '',
    disk: raw.d ?? '',
    diskSides: raw.ds ?? [],
    isDiskOnly: raw.f == null && raw.k == null && raw.d != null,
    snap48: raw.n ?? '',
    snap128: raw.nk ?? '',
    screen: raw.s ?? '',
    rom: raw.r ?? '',
  };
}

/** What to do when the user plays `game` from the current machine: which model
 *  to be on, which file to mount, and how to kick off the loader. */
export interface LoadPlan {
  target: SpectrumModel;     // model to load it on (may equal the current one)
  link: string;             // ZXDB file_link to fetch + mount
  isDisk: boolean;          // disk image vs tape
  // How to start it: press Enter on the 128K/+3 loader menu, jump the 48K ROM
  // loader, mount a ZX Interface 2 cartridge (self-boots on reset, no loader
  // kick), or — for a snapshot — nothing (it restores running state itself).
  boot: 'menu' | 'rom48k' | 'snapshot' | 'rom';
}

/**
 * Pick the best load for `game` from the current machine, preferring to stay put
 * and only upgrading when needed:
 *   - A ROM cartridge (16K/48K only) always wins when present — instant load,
 *     no tape-loading wait — switching down to 48K if needed.
 *   - +3: a disk loads from A: (menu); otherwise a tape (prefer 128K) via menu.
 *   - 128/+2/+2A: a tape (prefer 128K) via menu; a disk-only game upgrades to +3.
 *   - 48K (or 16K/other): a 48K tape jumps the ROM loader; a 128K-only tape
 *     upgrades to 128K; a disk-only game upgrades to +3.
 * A snapshot-only game (no tape/disk/rom) falls back to its snapshot, loaded on
 * the snapshot's native model and mounted directly (boot 'snapshot', no loader
 * kick). Returns null only when the game has no playable file at all.
 */
export function planLoad(game: Game, current: MachineModel): LoadPlan | null {
  const { tape48, tape128, disk, snap48, snap128, rom } = game;
  if (rom) return { target: '48k', link: rom, isDisk: false, boot: 'rom' };
  const anyTape = tape128 || tape48;   // prefer the 128K tape where a machine runs it

  if (isPlus3(current)) {
    if (disk) return { target: '+3', link: disk, isDisk: true, boot: 'menu' };
    if (anyTape) return { target: '+3', link: anyTape, isDisk: false, boot: 'menu' };
  } else if (is128kClass(current)) {   // 128 / +2 / +2A (not +3, handled above)
    if (anyTape) return { target: current as SpectrumModel, link: anyTape, isDisk: false, boot: 'menu' };
    if (disk) return { target: '+3', link: disk, isDisk: true, boot: 'menu' };
  } else {
    // 48K, 16K, or a non-Spectrum machine: load on the minimal Spectrum that fits.
    if (tape48)  return { target: '48k', link: tape48, isDisk: false, boot: 'rom48k' };
    if (tape128) return { target: '128k', link: tape128, isDisk: false, boot: 'menu' };
    if (disk)    return { target: '+3', link: disk, isDisk: true, boot: 'menu' };
  }
  // Snapshot fallback (present only when there's no tape/disk).
  if (snap128) return { target: '128k', link: snap128, isDisk: false, boot: 'snapshot' };
  if (snap48)  return { target: '48k', link: snap48, isDisk: false, boot: 'snapshot' };
  return null;
}

/** What a game needs to play, for the row's "needs 128/+3/ROM" badge: 'rom'
 *  (a ZX Interface 2 cartridge — takes priority over every other format),
 *  '48' (48K tape or snapshot), '128' (128K-only tape or snapshot), or '+3'
 *  (disk-only). */
export function gameNeeds(game: Game): '48' | '128' | '+3' | 'rom' {
  if (game.rom) return 'rom';
  if (game.tape48) return '48';
  if (game.tape128) return '128';
  if (game.disk) return '+3';
  if (game.snap128) return '128';
  return '48';   // 48K snapshot (or, defensively, nothing)
}

// ── Catalog fetch / cache ─────────────────────────────────────────────────

const CATALOG_CACHE_KEY = 'game-catalog';      // IndexedDB: the gzipped catalog bytes
const CATALOG_VERSION_KEY = 'catalog-version'; // localStorage: hash of the cached catalog

const CATALOG_BASE = 'https://zx84files.bitsparse.com/library';
/** Default location of the gzipped catalog. */
export const DEFAULT_CATALOG_URL = `${CATALOG_BASE}/catalog.json.gz`;
/** Tiny `{ "version": "<hash>" }` manifest, fetched each load to detect updates. */
const CATALOG_VERSION_URL = `${CATALOG_BASE}/catalog-version.json`;

/** gzip magic bytes (0x1f 0x8b) — distinguishes a .gz blob from plain JSON. */
function isGzip(d: Uint8Array): boolean {
  return d.length >= 2 && d[0] === 0x1f && d[1] === 0x8b;
}

/** Decompress gzip bytes via the browser DecompressionStream (no runtime deps). */
async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(data as unknown as BufferSource);
  writer.close();

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Fetch the published catalog version hash, or '' if it can't be reached. */
async function remoteCatalogVersion(): Promise<string> {
  try {
    // Cache-bust so we always see the freshly deployed version, never a CDN copy.
    const resp = await fetch(`${CATALOG_VERSION_URL}?_=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) return '';
    const data = await resp.json() as { version?: string };
    return `${data.version ?? ''}`;
  } catch {
    return '';
  }
}

/**
 * Fetch and decode the catalog, refreshing it when the published version differs
 * from the cached one. On every call we fetch the tiny version manifest; the
 * 0.42 MB catalog is only re-downloaded when its hash changed (or there's no
 * cache). Falls back to the cached copy when offline.
 *
 * Robust to either hosting style: a raw `.gz` object (we gunzip it) or a server
 * that already transfer-decodes it to plain JSON (we decode directly).
 */
export async function fetchCatalog(): Promise<RawCatalog> {
  const cachedVersion = getSaved(CATALOG_VERSION_KEY, '');
  const remoteVersion = await remoteCatalogVersion();
  let bytes = await dbLoad(CATALOG_CACHE_KEY);
  const haveCache = !!bytes && bytes.length > 0;

  // Re-download when there's no cache, or the published hash differs. An empty
  // remoteVersion means the check failed (offline) → keep whatever we cached.
  const stale = remoteVersion !== '' && remoteVersion !== cachedVersion;
  if (!haveCache || stale) {
    try {
      // ?v=<hash> gives each release a distinct CDN cache key; 'reload' skips the
      // browser cache so a changed catalog is actually re-fetched.
      const url = remoteVersion ? `${DEFAULT_CATALOG_URL}?v=${remoteVersion}` : DEFAULT_CATALOG_URL;
      const resp = await fetch(url, { cache: 'reload' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      bytes = new Uint8Array(await resp.arrayBuffer());
      await dbSave(CATALOG_CACHE_KEY, bytes).catch(() => { /* quota — re-fetch next time */ });
      if (remoteVersion) setSaved(CATALOG_VERSION_KEY, remoteVersion);
    } catch (err) {
      if (!haveCache) throw err;   // no fallback available
      // else: keep serving the stale cache we already have
    }
  }

  if (!bytes || bytes.length === 0) throw new Error('No catalog data');
  const json = new TextDecoder().decode(isGzip(bytes) ? await gunzip(bytes) : bytes);
  return JSON.parse(json) as RawCatalog;
}

/** Drop the cached catalog blob so the next fetch re-downloads it. */
export function clearCatalogCache(): Promise<void> {
  return dbSave(CATALOG_CACHE_KEY, new Uint8Array(0)).catch(() => {});
}
