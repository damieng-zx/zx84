/**
 * Game Library state — the loaded catalog plus the search box value and
 * load status. Derivations (resolved + filtered game lists) live in
 * GameLibraryPane, which has a reactive root to own the memos.
 */

import { createSignal } from 'solid-js';
import type { RawCatalog, Game } from '@/library/catalog.ts';

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
const _mounted = createSignal<{ game: Game; name: string; kind: 'tape' | 'disk' } | null>(null);
export const mounted = _mounted[0];
export const setMounted = _mounted[1];
