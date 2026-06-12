/**
 * Node-side access to the ZX84 game library catalog for the MCP server.
 *
 * The browser app fetches the gzipped ZXDB-derived catalog and caches it in
 * IndexedDB (see src/library/catalog.ts `fetchCatalog`). That path is
 * browser-only (IndexedDB/localStorage), so here we do a plain fetch + on-disk
 * cache under the MCP `.cache` dir. The *pure* resolution logic — `planLoad`,
 * `fileUrls`, `resolveGame`, `gameNeeds`, `basename` — is imported straight from
 * the app module so the MCP exercises exactly the same Library decisions the UI
 * does (which is the whole point: debugging why a Library title won't load).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
  resolveGame, fileUrls, planLoad, gameNeeds, basename,
  DEFAULT_CATALOG_URL, type RawCatalog, type Game,
} from '../src/library/catalog.ts';
import { CACHE_DIR } from './rom-fetch.ts';

export { fileUrls, planLoad, gameNeeds, basename, type Game };

const CACHE_FILE = path.join(CACHE_DIR, 'catalog.json.gz');

let cached: RawCatalog | null = null;

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
