/**
 * SAM Coupé software catalog — the client half of `tools/build-sam-catalog.ts`.
 *
 * ZXDB carries a little over two hundred bootable SAM titles under its own
 * machine type, so they are published as a catalog of their own rather than
 * squeezed into the Spectrum one, whose slots (16K/48K/128K tape, +3 disk,
 * microdrive, Interface 2 ROM) describe Spectrum hardware and mean nothing
 * here. Same shape as the ZX80/81 catalog, for the same reason.
 */

import { dbLoad, dbSave, getSaved, setSaved } from '@/store/persistence.ts';

/** Compact wire schema — keep in sync with RawGame in the builder. */
export interface RawSamGame {
  i: number;
  t: string;
  y?: number;
  g?: number;
  p?: number;
  /** First (usually only) disk. */
  d?: string;
  /** Further disks of a set: [file_link, label]. */
  ds?: [string, string][];
  /** Tape image, for the handful of titles released on cassette. */
  f?: string;
  s?: string;
  /** Further screenshots, in preference order — see `screens`. */
  sx?: string[];
}

export interface RawSamCatalog {
  genres: string[];
  publishers: string[];
  games: RawSamGame[];
}

/** The media a title is available on. Both filter the browser's list. */
export type SamLibraryFormat = 'disk' | 'tape';

export const SAM_LIBRARY_FORMATS: readonly SamLibraryFormat[] = ['disk', 'tape'];

export interface SamGame {
  id: number;
  title: string;
  year: number | null;
  genre: string;
  publisher: string;
  /** Every disk of the release, in order; empty for a tape-only title. */
  disks: { link: string; label: string }[];
  tape: string;
  /**
   * Every published screenshot, best first.
   *
   * More than one because the best is not guaranteed to be fetchable: the file
   * host serves some of ZXDB's screen extensions and not others, so the viewer
   * works down the list until one arrives.
   */
  screens: string[];
  /** The preferred screenshot, or '' — `screens[0]`, kept for brevity. */
  screen: string;
  formats: SamLibraryFormat[];
}

export function resolveSamGame(raw: RawSamGame, catalog: RawSamCatalog): SamGame {
  const disks = raw.d ? [{ link: raw.d, label: 'Disk 1' }] : [];
  for (const [link, label] of raw.ds ?? []) disks.push({ link, label });
  const formats: SamLibraryFormat[] = [];
  if (disks.length) formats.push('disk');
  if (raw.f) formats.push('tape');
  const screens = [raw.s, ...(raw.sx ?? [])].filter((link): link is string => !!link);
  return {
    id: raw.i,
    title: raw.t,
    year: raw.y ?? null,
    genre: raw.g === undefined ? '' : catalog.genres[raw.g] ?? '',
    publisher: raw.p === undefined ? '' : catalog.publishers[raw.p] ?? '',
    disks,
    tape: raw.f ?? '',
    screens,
    screen: screens[0] ?? '',
    formats,
  };
}

export function resolveSamGames(catalog: RawSamCatalog): SamGame[] {
  return catalog.games.map(raw => resolveSamGame(raw, catalog));
}

/** A title matches when it is available on any of the selected formats; an
 *  empty selection means "no format filtering". */
export function matchesSamFormatFilter(
  game: SamGame,
  selected: ReadonlySet<SamLibraryFormat>,
): boolean {
  return !selected.size || game.formats.some(format => selected.has(format));
}

export function matchesSamGenreFilter(game: SamGame, selected: ReadonlySet<string>): boolean {
  return !selected.size || selected.has(game.genre);
}

/** What the browser launches by default: the first disk, else the tape. */
export function primarySamFile(game: SamGame): string {
  return game.disks[0]?.link ?? game.tape;
}

const BASE = 'https://zx84files.bitsparse.com/library';
export const DEFAULT_SAM_CATALOG_URL = `${BASE}/sam-catalog.json.gz`;
const VERSION_URL = `${BASE}/sam-catalog-version.json`;
const CACHE_KEY = 'sam-game-catalog';
const VERSION_KEY = 'sam-catalog-version';

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

/** Fetch the catalog, preferring the IndexedDB copy and re-downloading only
 *  when the published version string has moved on. */
export async function fetchSamCatalog(): Promise<RawSamCatalog> {
  const published = await remoteVersion();
  const savedVersion = getSaved(VERSION_KEY, '');
  let bytes = await dbLoad(CACHE_KEY);
  const cached = !!bytes?.length;
  if (!cached || (published && published !== savedVersion)) {
    try {
      const response = await fetch(
        published ? `${DEFAULT_SAM_CATALOG_URL}?v=${published}` : DEFAULT_SAM_CATALOG_URL,
        { cache: 'reload' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      await dbSave(CACHE_KEY, bytes).catch(() => {});
      if (published) setSaved(VERSION_KEY, published);
    } catch (error) {
      if (!cached) throw error;
    }
  }
  if (!bytes?.length) throw new Error('No SAM Coupé catalog data');
  return JSON.parse(new TextDecoder().decode(await gunzip(bytes))) as RawSamCatalog;
}
