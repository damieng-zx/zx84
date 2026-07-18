/**
 * Game Library state — the loaded catalog plus the search box value and
 * load status. Derivations (resolved + filtered game lists) live in
 * LibraryBrowser, which has a reactive root to own the memos.
 */

import { createSignal } from 'solid-js';
import type { RawCatalog, Game, LibraryFormat, LibraryMachine } from '@/library/catalog.ts';

const _catalog = createSignal<RawCatalog | null>(null);
export const catalog = _catalog[0];
export const setCatalog = _catalog[1];

const _query = createSignal('');
export const query = _query[0];
export const setQuery = _query[1];

const _libraryLoading = createSignal(false);
export const libraryLoading = _libraryLoading[0];
export const setLibraryLoading = _libraryLoading[1];

const _libraryError = createSignal('');
export const libraryError = _libraryError[0];
export const setLibraryError = _libraryError[1];

/** The exact game row currently downloading (for the "loading" indicator), or
 *  null. Keyed by object identity so duplicate titles don't both highlight. */
const _loadingGame = createSignal<Game | null>(null);
export const loadingGame = _loadingGame[0];
export const setLoadingGame = _loadingGame[1];

/** The library entry whose file is currently mounted, with the resulting media
 *  name + kind so we can tell when it has been ejected or replaced. Null when
 *  nothing loaded from the library is mounted. */
const _mounted = createSignal<{ game: Game; name: string; kind: 'tape' | 'disk' | 'rom' } | null>(null);
export const mounted = _mounted[0];
export const setMounted = _mounted[1];

// ── Genre filter (persisted) ───────────────────────────────────────────────
// Set of genre names to include; empty = no genre filtering (show all).

const GENRE_FILTER_KEY = 'zx84-library-genres';

function loadGenreFilter(): Set<string> {
  try {
    const raw = localStorage.getItem(GENRE_FILTER_KEY);
    if (raw) return new Set<string>(JSON.parse(raw));
  } catch { /* */ }
  return new Set();
}

const _genreFilter = createSignal<Set<string>>(loadGenreFilter());
export const genreFilter = _genreFilter[0];
const setGenreFilter = _genreFilter[1];

function persistGenreFilter(s: Set<string>): void {
  try {
    if (s.size === 0) localStorage.removeItem(GENRE_FILTER_KEY);
    else localStorage.setItem(GENRE_FILTER_KEY, JSON.stringify([...s]));
  } catch { /* */ }
}

export function toggleGenreFilter(genre: string): void {
  const s = new Set(genreFilter());
  if (s.has(genre)) s.delete(genre); else s.add(genre);
  setGenreFilter(s);
  persistGenreFilter(s);
}

/** Toggle a whole group at once: if every member is already selected, clear
 *  them all; otherwise select the lot. Used by the parent "include everything"
 *  click on a genre category. */
export function toggleGenreGroup(members: string[]): void {
  const s = new Set(genreFilter());
  const allOn = members.length > 0 && members.every(m => s.has(m));
  for (const m of members) { if (allOn) s.delete(m); else s.add(m); }
  setGenreFilter(s);
  persistGenreFilter(s);
}

export function clearGenreFilter(): void {
  const empty = new Set<string>();
  setGenreFilter(empty);
  persistGenreFilter(empty);
}

// ── Format / machine filters (persisted) ────────────────────────────────────
// Each set is ORed internally; the browser combines non-empty sets with AND.

const ALL_FORMATS: LibraryFormat[] = ['tape', 'plus3-disk', 'mgt-disk', 'snapshot', 'rom', 'microdrive'];
const ALL_MACHINES: LibraryMachine[] = ['16', '48', '128', '+3'];

const FORMAT_FILTER_KEY = 'zx84-library-media-formats';
const MACHINE_FILTER_KEY = 'zx84-library-machines';

function loadFilter<T extends string>(key: string, allowed: readonly T[]): Set<T> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const values = JSON.parse(raw);
      if (Array.isArray(values)) return new Set(values.filter((v): v is T => typeof v === 'string' && allowed.includes(v as T)));
    }
  } catch { /* */ }
  return new Set();
}

function persistFilter<T extends string>(key: string, s: Set<T>): void {
  try {
    if (s.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...s]));
  } catch { /* */ }
}

const _formatFilter = createSignal<Set<LibraryFormat>>(loadFilter(FORMAT_FILTER_KEY, ALL_FORMATS));
export const formatFilter = _formatFilter[0];
const setFormatFilter = _formatFilter[1];

export function toggleFormatFilter(fmt: LibraryFormat): void {
  const s = new Set(formatFilter());
  if (s.has(fmt)) s.delete(fmt); else s.add(fmt);
  setFormatFilter(s);
  persistFilter(FORMAT_FILTER_KEY, s);
}

/** Parent "Format" click: clear all formats if every one is already on,
 *  otherwise select them all. */
export function toggleFormatGroup(): void {
  const s = new Set(formatFilter());
  const allOn = ALL_FORMATS.every(m => s.has(m));
  for (const m of ALL_FORMATS) { if (allOn) s.delete(m); else s.add(m); }
  setFormatFilter(s);
  persistFilter(FORMAT_FILTER_KEY, s);
}

const _machineFilter = createSignal<Set<LibraryMachine>>(loadFilter(MACHINE_FILTER_KEY, ALL_MACHINES));
export const machineFilter = _machineFilter[0];
const setMachineFilter = _machineFilter[1];

export function toggleMachineFilter(machine: LibraryMachine): void {
  const s = new Set(machineFilter());
  if (s.has(machine)) s.delete(machine); else s.add(machine);
  setMachineFilter(s);
  persistFilter(MACHINE_FILTER_KEY, s);
}

/** Parent "Machine" click: clear all machines if every one is already on,
 * otherwise select them all. */
export function toggleMachineGroup(): void {
  const s = new Set(machineFilter());
  const allOn = ALL_MACHINES.every(m => s.has(m));
  for (const m of ALL_MACHINES) { if (allOn) s.delete(m); else s.add(m); }
  setMachineFilter(s);
  persistFilter(MACHINE_FILTER_KEY, s);
}
