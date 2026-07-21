/**
 * Node-side access to the ZX84 game library catalog for the MCP server.
 *
 * The browser app fetches the gzipped ZXDB-derived catalog and caches it in
 * IndexedDB (see src/library/catalog.ts `fetchCatalog`). That path is
 * browser-only (IndexedDB/localStorage), so here we do a plain fetch + on-disk
 * cache under the MCP `.cache` dir. The *pure* resolution logic — `planLoad`,
 * `fileUrls`, `resolveGame`, `availableFormats`, `basename` — is imported straight from
 * the app module so the MCP exercises exactly the same Library decisions the UI
 * does (which is the whole point: debugging why a Library title won't load).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
  resolveGame, fileUrls, planLoad, availableFormats, basename,
  DEFAULT_CATALOG_URL, type RawCatalog, type Game,
} from '../src/library/catalog.ts';
import {
  DEFAULT_ZX8X_CATALOG_URL, resolveZx8xGame,
  type RawZx8xCatalog, type Zx8xGame,
} from '../src/library/zx8x-catalog.ts';
import type { Zx8xModel } from '../src/machines/zx8x/models.ts';
import { CACHE_DIR } from './rom-fetch.ts';

export { fileUrls, planLoad, availableFormats, basename, type Game };

const CACHE_FILE = path.join(CACHE_DIR, 'catalog.json.gz');
const ZX8X_CACHE_FILE = path.join(CACHE_DIR, 'zx8x-catalog.json.gz');

let cached: RawCatalog | null = null;
let cachedZx8x: RawZx8xCatalog | null = null;

/** gzip magic (0x1f 0x8b). */
function isGzip(d: Uint8Array): boolean {
  return d.length >= 2 && d[0] === 0x1f && d[1] === 0x8b;
}

/**
 * Load the catalog, preferring the on-disk cache. Pass `refresh` to force a
 * re-download (the catalog is updated upstream over time; ROMs never change but
 * this does). Falls back to the cache when the network is unavailable.
 */
export async function loadCatalog(refresh = false): Promise<RawCatalog> {
  if (cached && !refresh) return cached;

  let bytes: Uint8Array | null = null;
  const haveCache = fs.existsSync(CACHE_FILE);

  if (refresh || !haveCache) {
    try {
      const resp = await fetch(DEFAULT_CATALOG_URL, { cache: 'reload' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      bytes = new Uint8Array(await resp.arrayBuffer());
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, bytes);
    } catch (err) {
      if (!haveCache) throw new Error(`Catalog download failed: ${(err as Error).message}`);
      // else fall through to the stale cache we already have
    }
  }
  if (!bytes) bytes = new Uint8Array(fs.readFileSync(CACHE_FILE));

  const json = new TextDecoder().decode(isGzip(bytes) ? zlib.gunzipSync(bytes) : bytes);
  cached = JSON.parse(json) as RawCatalog;
  return cached;
}

/** Resolve every catalog entry whose title matches `title` exactly (case-
 *  insensitive). ZXDB can hold several entries under one title, hence an array. */
export async function findGames(title: string, refresh = false): Promise<Game[]> {
  const cat = await loadCatalog(refresh);
  const want = title.trim().toLowerCase();
  return cat.games.filter(g => g.t.toLowerCase() === want).map(g => resolveGame(g, cat));
}

/** Up to `limit` titles containing `query` (case-insensitive), for "did you
 *  mean" hints when an exact match fails. Deduplicated, in catalog order. */
export async function suggestTitles(query: string, limit = 15): Promise<string[]> {
  const cat = await loadCatalog();
  const want = query.trim().toLowerCase();
  if (!want) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of cat.games) {
    if (!g.t.toLowerCase().includes(want)) continue;
    if (seen.has(g.t)) continue;
    seen.add(g.t);
    out.push(g.t);
    if (out.length >= limit) break;
  }
  return out;
}

/** Node-side ZX80/ZX81 catalog loader, with the same disk-cache policy as the
 * Spectrum catalog. */
export async function loadZx8xCatalog(refresh = false): Promise<RawZx8xCatalog> {
  if (cachedZx8x && !refresh) return cachedZx8x;

  let bytes: Uint8Array | null = null;
  const haveCache = fs.existsSync(ZX8X_CACHE_FILE);
  if (refresh || !haveCache) {
    try {
      const response = await fetch(DEFAULT_ZX8X_CATALOG_URL, { cache: 'reload' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(ZX8X_CACHE_FILE, bytes);
    } catch (error) {
      if (!haveCache) throw new Error(`ZX80/ZX81 catalog download failed: ${(error as Error).message}`);
    }
  }
  if (!bytes) bytes = new Uint8Array(fs.readFileSync(ZX8X_CACHE_FILE));
  const json = new TextDecoder().decode(isGzip(bytes) ? zlib.gunzipSync(bytes) : bytes);
  cachedZx8x = JSON.parse(json) as RawZx8xCatalog;
  return cachedZx8x;
}

/** Exact-title lookup constrained to the active model. It intentionally never
 * returns a ZX81 title to ZX80 (or vice versa) and never triggers a model swap. */
export async function findZx8xGames(title: string, model: Zx8xModel, refresh = false): Promise<Zx8xGame[]> {
  const catalog = await loadZx8xCatalog(refresh);
  const want = title.trim().toLowerCase();
  const numericModel = model === 'zx80' ? 80 : 81;
  return catalog.games
    .filter(game => game.m === numericModel && game.t.toLowerCase() === want)
    .map(game => resolveZx8xGame(game, catalog));
}

export async function suggestZx8xTitles(query: string, model: Zx8xModel, limit = 15): Promise<string[]> {
  const catalog = await loadZx8xCatalog();
  const want = query.trim().toLowerCase();
  if (!want) return [];
  const numericModel = model === 'zx80' ? 80 : 81;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const game of catalog.games) {
    if (game.m !== numericModel || !game.t.toLowerCase().includes(want) || seen.has(game.t)) continue;
    seen.add(game.t);
    out.push(game.t);
    if (out.length >= limit) break;
  }
  return out;
}
