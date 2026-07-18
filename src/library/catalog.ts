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

/** One game in the compact on-wire schema. Short keys keep the JSON small. Each
 *  slot retains one preferred file for a format and its native machine class.
 *  The UI derives format and compatible-machine filters from these slots. */
export interface RawGame {
  i: number;    // ZXDB entry id
  t: string;    // title
  y?: number;   // release year
  g?: number;   // genre — index into RawCatalog.genres
  p?: number;   // publisher — index into RawCatalog.publishers
  s?: string;   // screen image file_link (.scr, or raster .gif/.png/.jpg)
  a?: string;   // 16K/16K-48K tape file_link (.tzx preferred, else .tap)
  f?: string;   // 48K tape file_link
  k?: string;   // 128K tape file_link
  d?: string;   // disk file_link (.dsk) — side A / disk 1
  ds?: [string, string][]; // extra disk sides: [file_link, label]
  m?: string;   // MGT +D disk file_link for 48K-class machines (.mgt/.img)
  mk?: string;  // MGT +D disk file_link for 128K-class machines
  u?: string;   // Interface 1 microdrive file_link for 48K-class machines (.mdr/.mdv)
  uk?: string;  // Interface 1 microdrive file_link for 128K-class machines
  n16?: string; // 16K/16K-48K snapshot file_link (.szx/.z80/.sna)
  n?: string;   // 48K snapshot file_link
  nk?: string;  // 128K snapshot file_link
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
  /** ZXDB file_link for a 16K/16K-48K tape, '' when none. */
  tape16: string;
  /** ZXDB file_link for the 48K tape, '' when none. */
  tape48: string;
  /** ZXDB file_link for the 128K tape, '' when none. */
  tape128: string;
  /** ZXDB file_link for the primary +3 disk side, '' when none. */
  plus3Disk: string;
  /** Extra disk sides: [file_link, label]. */
  diskSides: [string, string][];
  /** ZXDB file_link for an MGT +D disk on a 48K-class machine, '' when none. */
  mgt48: string;
  /** ZXDB file_link for an MGT +D disk on a 128K-class machine, '' when none. */
  mgt128: string;
  /** ZXDB file_link for an Interface 1 cartridge on a 48K-class machine, '' when none. */
  microdrive48: string;
  /** ZXDB file_link for an Interface 1 cartridge on a 128K-class machine, '' when none. */
  microdrive128: string;
  /** ZXDB file_link for a 16K/16K-48K snapshot, '' when none. */
  snap16: string;
  /** ZXDB file_link for a 48K snapshot, '' when none. */
  snap48: string;
  /** ZXDB file_link for a 128K snapshot, '' when none. */
  snap128: string;
  /** ZXDB file_link for a screen image — a native .scr dump or a raster
   *  .gif/.png/.jpg loading/in-game screen ('' when none). */
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
    tape16: raw.a ?? '',
    tape48: raw.f ?? '',
    tape128: raw.k ?? '',
    plus3Disk: raw.d ?? '',
    diskSides: raw.ds ?? [],
    mgt48: raw.m ?? '',
    mgt128: raw.mk ?? '',
    microdrive48: raw.u ?? '',
    microdrive128: raw.uk ?? '',
    snap16: raw.n16 ?? '',
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
  kind: 'tape' | 'plus3-disk' | 'mgt-disk' | 'snapshot' | 'rom' | 'microdrive';
  peripheral?: 'plusd' | 'interface1';
  // How to start it: press Enter on the 128K/+3 loader menu, jump the 48K ROM
  // loader, mount a ZX Interface 2 cartridge (self-boots on reset, no loader
  // kick), or — for a snapshot — nothing (it restores running state itself).
  boot: 'menu' | 'rom48k' | 'snapshot' | 'rom' | 'peripheral';
}

/** Select a specific requested media format while preserving the current model
 * where it can run that format. Used when the library Format filter is active. */
function planFormat(game: Game, current: MachineModel, format: LibraryFormat): LoadPlan | null {
  const { tape16, tape48, tape128, plus3Disk, mgt48, mgt128, microdrive48, microdrive128, snap16, snap48, snap128, rom } = game;
  const peripheral = (kind: 'mgt-disk' | 'microdrive', link48: string, link128: string): LoadPlan | null => {
    const peripheralName = kind === 'mgt-disk' ? 'plusd' : 'interface1';
    if (is128kClass(current) && !isPlus3(current)) {
      const target = current === '+2A' ? '128k' : current as SpectrumModel;
      if (link128 || link48) return { target, link: link128 || link48, kind, peripheral: peripheralName, boot: 'peripheral' };
    }
    if (link48) return { target: '48k', link: link48, kind, peripheral: peripheralName, boot: 'peripheral' };
    if (link128) return { target: '128k', link: link128, kind, peripheral: peripheralName, boot: 'peripheral' };
    return null;
  };

  switch (format) {
    case 'tape':
      if (isPlus3(current)) {
        if (tape128 || tape48 || tape16) return { target: '+3', link: tape128 || tape48 || tape16, kind: 'tape', boot: 'menu' };
      } else if (is128kClass(current)) {
        if (tape128 || tape48 || tape16) return { target: current as SpectrumModel, link: tape128 || tape48 || tape16, kind: 'tape', boot: 'menu' };
      } else if (current === '16k' && tape16) {
        return { target: '16k', link: tape16, kind: 'tape', boot: 'rom48k' };
      }
      if (tape48 || tape16) return { target: '48k', link: tape48 || tape16, kind: 'tape', boot: 'rom48k' };
      if (tape128) return { target: '128k', link: tape128, kind: 'tape', boot: 'menu' };
      return null;
    case 'plus3-disk':
      return plus3Disk ? { target: '+3', link: plus3Disk, kind: 'plus3-disk', boot: 'menu' } : null;
    case 'mgt-disk': return peripheral('mgt-disk', mgt48, mgt128);
    case 'snapshot':
      if (snap128) return { target: '128k', link: snap128, kind: 'snapshot', boot: 'snapshot' };
      if (snap48) return { target: '48k', link: snap48, kind: 'snapshot', boot: 'snapshot' };
      return snap16 ? { target: '16k', link: snap16, kind: 'snapshot', boot: 'snapshot' } : null;
    case 'rom': return rom ? { target: current === '16k' ? '16k' : '48k', link: rom, kind: 'rom', boot: 'rom' } : null;
    case 'microdrive': return peripheral('microdrive', microdrive48, microdrive128);
  }
}

/**
 * Pick the best load for `game` from the current machine, preferring to stay put
 * and only upgrading when needed:
 *   - A ROM cartridge (16K/48K only) always wins when present — instant load,
 *     no tape-loading wait — switching down to 48K if needed.
 *   - +3: a +3 disk loads from A: (menu); otherwise a tape (prefer 128K) via menu.
 *   - 128/+2/+2A: a tape (prefer 128K) via menu; peripheral media stays on a
 *     compatible 48K/128K machine.
 *   - 48K/16K (or a non-Spectrum machine): use the smallest compatible model.
 * Snapshots mount directly on their native model. Returns null only when the
 * game has no playable file at all.
 */
export function planLoad(game: Game, current: MachineModel, preferredFormats: Iterable<LibraryFormat> = []): LoadPlan | null {
  // A Format filter is an explicit request for its medium, not merely a way to
  // find titles. Preserve Set insertion order when more than one is selected.
  for (const format of preferredFormats) {
    const preferred = planFormat(game, current, format);
    if (preferred) return preferred;
  }
  const { tape16, tape48, tape128, plus3Disk, mgt48, mgt128, microdrive48, microdrive128, snap16, snap48, snap128, rom } = game;
  if (rom) return { target: current === '16k' ? '16k' : '48k', link: rom, kind: 'rom', boot: 'rom' };
  const anyTape = tape128 || tape48 || tape16;

  if (isPlus3(current)) {
    if (plus3Disk) return { target: '+3', link: plus3Disk, kind: 'plus3-disk', boot: 'menu' };
    if (anyTape) return { target: '+3', link: anyTape, kind: 'tape', boot: 'menu' };
  } else if (is128kClass(current)) {   // 128 / +2 / +2A (not +3, handled above)
    if (anyTape) return { target: current as SpectrumModel, link: anyTape, kind: 'tape', boot: 'menu' };
    // The +2A is 128K-class but its Amstrad edge connector cannot host the +D
    // or Interface 1. Use a plain 128K model when a peripheral is needed.
    const peripheralTarget = current === '128k' || current === '+2' ? current as SpectrumModel : '128k';
    if (mgt128 || mgt48) return { target: peripheralTarget, link: mgt128 || mgt48, kind: 'mgt-disk', peripheral: 'plusd', boot: 'peripheral' };
    if (microdrive128 || microdrive48) return { target: peripheralTarget, link: microdrive128 || microdrive48, kind: 'microdrive', peripheral: 'interface1', boot: 'peripheral' };
    if (plus3Disk) return { target: '+3', link: plus3Disk, kind: 'plus3-disk', boot: 'menu' };
  } else {
    const is16 = current === '16k';
    if (is16 && tape16) return { target: '16k', link: tape16, kind: 'tape', boot: 'rom48k' };
    if (!is16 && tape48) return { target: '48k', link: tape48, kind: 'tape', boot: 'rom48k' };
    if (tape16) return { target: '48k', link: tape16, kind: 'tape', boot: 'rom48k' };
    if (tape48) return { target: '48k', link: tape48, kind: 'tape', boot: 'rom48k' };
    if (mgt48) return { target: '48k', link: mgt48, kind: 'mgt-disk', peripheral: 'plusd', boot: 'peripheral' };
    if (microdrive48) return { target: '48k', link: microdrive48, kind: 'microdrive', peripheral: 'interface1', boot: 'peripheral' };
    if (tape128) return { target: '128k', link: tape128, kind: 'tape', boot: 'menu' };
    if (mgt128) return { target: '128k', link: mgt128, kind: 'mgt-disk', peripheral: 'plusd', boot: 'peripheral' };
    if (microdrive128) return { target: '128k', link: microdrive128, kind: 'microdrive', peripheral: 'interface1', boot: 'peripheral' };
    if (plus3Disk) return { target: '+3', link: plus3Disk, kind: 'plus3-disk', boot: 'menu' };
  }
  if (snap128) return { target: '128k', link: snap128, kind: 'snapshot', boot: 'snapshot' };
  if (snap48) return { target: '48k', link: snap48, kind: 'snapshot', boot: 'snapshot' };
  if (snap16) return { target: '16k', link: snap16, kind: 'snapshot', boot: 'snapshot' };
  return null;
}

export type LibraryFormat = 'tape' | 'plus3-disk' | 'mgt-disk' | 'snapshot' | 'rom' | 'microdrive';
export type LibraryMachine = '16' | '48' | '128' | '+3';

/** Whether a title has a retained image of the requested media format. */
export function hasFormat(game: Game, format: LibraryFormat): boolean {
  switch (format) {
    case 'tape': return !!(game.tape16 || game.tape48 || game.tape128);
    case 'plus3-disk': return !!game.plus3Disk;
    case 'mgt-disk': return !!(game.mgt48 || game.mgt128);
    case 'snapshot': return !!(game.snap16 || game.snap48 || game.snap128);
    case 'rom': return !!game.rom;
    case 'microdrive': return !!(game.microdrive48 || game.microdrive128);
  }
}

/** Retained media formats in display order. */
export function availableFormats(game: Game): LibraryFormat[] {
  const formats: LibraryFormat[] = ['tape', 'plus3-disk', 'mgt-disk', 'snapshot', 'rom', 'microdrive'];
  return formats.filter(format => hasFormat(game, format));
}

/** Whether at least one retained image can run on this Spectrum model. */
export function supportsMachine(game: Game, machine: LibraryMachine): boolean {
  switch (machine) {
    case '16': return !!(game.tape16 || game.snap16 || game.rom);
    case '48': return !!(game.tape16 || game.tape48 || game.snap16 || game.snap48 || game.rom || game.mgt48 || game.microdrive48);
    case '128': return !!(game.tape16 || game.tape48 || game.tape128 || game.snap16 || game.snap48 || game.snap128 || game.mgt48 || game.mgt128 || game.microdrive48 || game.microdrive128);
    case '+3': return !!(game.tape16 || game.tape48 || game.tape128 || game.snap16 || game.snap48 || game.snap128 || game.plus3Disk);
  }
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
