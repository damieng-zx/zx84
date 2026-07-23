import { dbLoad, dbSave, getSaved, setSaved } from '@/store/persistence.ts';
import { zx8xHardwareOverride, type Zx81HiResMode } from './zx8x-hardware.ts';

export interface RawZx8xGame {
  i: number;
  t: string;
  m: 80 | 81;
  y?: number;
  g?: number;
  p?: number;
  f: string;
  s?: string;
  /** Required RAM in KB, taken from ZXDB's machine type. */
  r?: number;
  /** Compact hi-res mode: software, UDG, UDG-128, WRX, Memotech, or QuickSilva. */
  h?: 's' | 'u' | 'r' | 'w' | 'm' | 'q';
  /** Indices into the catalog's ZX81 enhanced-graphics dictionary. */
  x?: number[];
}

export interface RawZx8xCatalog {
  genres: string[];
  publishers: string[];
  /** ZXDB tag type Z: ZX81 Enhanced Graphics. Absent in older catalogs. */
  graphics?: string[];
  games: RawZx8xGame[];
}

export interface Zx8xGame {
  id: number;
  title: string;
  model: 'zx80' | 'zx81';
  year: number | null;
  genre: string;
  publisher: string;
  file: string;
  screen: string;
  ramKb: number | null;
  hiRes: Zx81HiResMode | null;
  enhancedGraphics: string[];
}

export function matchesZx8xHardwareFilters(
  game: Zx8xGame,
  selectedGraphics: ReadonlySet<string>,
  selectedMemory: ReadonlySet<number>,
): boolean {
  // ZXDB often leaves the RAM field blank for ordinary expanded titles. The
  // launcher already treats every non-1KB requirement as the emulator's 16KB
  // configuration, so filtering must use that same effective machine setup.
  const effectiveRamKb = game.ramKb === 1 ? 1 : 16;
  return (!selectedGraphics.size || game.enhancedGraphics.some(feature => selectedGraphics.has(feature)))
    && (!selectedMemory.size || selectedMemory.has(effectiveRamKb));
}

export function resolveZx8xGame(raw: RawZx8xGame, catalog: RawZx8xCatalog): Zx8xGame {
  const override = zx8xHardwareOverride(raw.i);
  const hiResCode = raw.h;
  return {
    id: raw.i,
    title: raw.t,
    model: raw.m === 80 ? 'zx80' : 'zx81',
    year: raw.y ?? null,
    genre: raw.g === undefined ? '' : catalog.genres[raw.g] ?? '',
    publisher: raw.p === undefined ? '' : catalog.publishers[raw.p] ?? '',
    file: raw.f,
    screen: raw.s ?? '',
    ramKb: raw.r ?? override?.ramKb ?? null,
    hiRes: hiResCode === 's' ? 'software'
      : hiResCode === 'u' ? 'udg'
      : hiResCode === 'r' ? 'udg128'
      : hiResCode === 'w' ? 'wrx'
      : hiResCode === 'm' ? 'memotech'
      : hiResCode === 'q' ? 'quicksilva'
      : override?.hiRes ?? null,
    enhancedGraphics: raw.x?.map(index => catalog.graphics?.[index] ?? '').filter(Boolean)
      ?? [...(override?.enhancedGraphics ?? [])],
  };
}

/** Expand only the software native to the selected machine. ZX80 and ZX81
 * programs are separate libraries; the browser must never offer a title that
 * would require changing the user's current model. */
export function resolveZx8xGamesForModel(
  catalog: RawZx8xCatalog,
  model: Zx8xGame['model'],
): Zx8xGame[] {
  return catalog.games
    .filter(raw => (model === 'zx80' ? raw.m === 80 : raw.m === 81))
    .map(raw => resolveZx8xGame(raw, catalog));
}

const BASE = 'https://zx84files.bitsparse.com/library';
export const DEFAULT_ZX8X_CATALOG_URL = `${BASE}/zx8x-catalog.json.gz`;
const VERSION_URL = `${BASE}/zx8x-catalog-version.json`;
const CACHE_KEY = 'zx8x-game-catalog';
const VERSION_KEY = 'zx8x-catalog-version';

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  if (data[0] !== 0x1f || data[1] !== 0x8b) return data;
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function remoteVersion(): Promise<string> {
  try {
    const response = await fetch(`${VERSION_URL}?_=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return '';
    return String(((await response.json()) as { version?: string }).version ?? '');
  } catch { return ''; }
}

export async function fetchZx8xCatalog(): Promise<RawZx8xCatalog> {
  const published = await remoteVersion();
  const savedVersion = getSaved(VERSION_KEY, '');
  let bytes = await dbLoad(CACHE_KEY);
  const cached = !!bytes?.length;
  if (!cached || (published && published !== savedVersion)) {
    try {
      const response = await fetch(published ? `${DEFAULT_ZX8X_CATALOG_URL}?v=${published}` : DEFAULT_ZX8X_CATALOG_URL, { cache: 'reload' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      await dbSave(CACHE_KEY, bytes).catch(() => {});
      if (published) setSaved(VERSION_KEY, published);
    } catch (error) {
      if (!cached) throw error;
    }
  }
  if (!bytes?.length) throw new Error('No ZX80/ZX81 catalog data');
  return JSON.parse(new TextDecoder().decode(await gunzip(bytes))) as RawZx8xCatalog;
}
