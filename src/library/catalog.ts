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

/** One game in the compact on-wire schema. Short keys keep the JSON small. */
export interface RawGame {
  t: string;    // title
  y?: number;   // release year
  g?: number;   // genre — index into RawCatalog.genres
  p?: number;   // publisher — index into RawCatalog.publishers
  f?: string;   // tape file_link (preferred: .tzx.zip, else .tap.zip)
  d?: string;   // disk file_link (.dsk.zip), when present
}

export interface RawCatalog {
  genres: string[];
  publishers: string[];
  games: RawGame[];
}

/** A catalog entry resolved for the UI (dictionary indices expanded). */
export interface Game {
  title: string;
  year: number | null;
  genre: string;
  publisher: string;
  /** ZXDB file_link for the file we'll load (tape preferred over disk). */
  fileLink: string;
  /** True when the chosen file is a disk image rather than a tape. */
  isDisk: boolean;
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
    title: raw.t,
    year: raw.y ?? null,
    genre: raw.g != null ? cat.genres[raw.g] ?? '' : '',
    publisher: raw.p != null ? cat.publishers[raw.p] ?? '' : '',
    // Prefer the tape; fall back to the disk image when no tape exists.
    fileLink: raw.f ?? raw.d ?? '',
    isDisk: raw.f == null && raw.d != null,
  };
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
