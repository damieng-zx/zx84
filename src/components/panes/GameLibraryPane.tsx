import { createMemo, createEffect, onMount, Show, For } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { loadFile } from '@/emulator.ts';
import { tapeName } from '@/state/tape-state.ts';
import { currentDiskName } from '@/state/disk-state.ts';
import {
  fetchCatalog, fileUrls, basename, resolveGame, shortPublisher, type Game,
} from '@/library/catalog.ts';
import {
  catalog, setCatalog, query, setQuery,
  libraryLoading, setLibraryLoading, libraryError, setLibraryError,
  loadingGame, setLoadingGame, mounted, setMounted,
} from '@/state/library-state.ts';

/** Fetch the first URL that returns 2xx; falls through to the next on error. */
async function fetchFirst(urls: string[]): Promise<Uint8Array> {
  let lastErr: unknown = new Error('No URL to fetch');
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Cap rendered rows — the catalog holds tens of thousands of entries, far more
// than is useful (or performant) to render at once. Users narrow via search.
const RESULT_LIMIT = 500;

export function GameLibraryPane() {
  // Resolve the compact entries once, when the catalog arrives.
  const games = createMemo<Game[]>(() => {
    const cat = catalog();
    return cat ? cat.games.map(g => resolveGame(g, cat)) : [];
  });

  // Case-insensitive title filter, capped for render performance. An empty
  // query yields nothing — we don't dump the whole (alphabetical) catalogue.
  const filtered = createMemo<Game[]>(() => {
    const q = query().trim().toLowerCase();
    if (!q) return [];
    const all = games();
    const out: Game[] = [];
    for (const g of all) {
      if (g.title.toLowerCase().includes(q)) {
        out.push(g);
        if (out.length >= RESULT_LIMIT) break;
      }
    }
    return out;
  });

  async function ensureCatalog() {
    if (catalog() || libraryLoading()) return;
    setLibraryLoading(true);
    setLibraryError('');
    try {
      setCatalog(await fetchCatalog());
    } catch (err) {
      console.warn('Failed to load game catalog:', err);
      setLibraryError('Could not load the game library catalog.');
    } finally {
      setLibraryLoading(false);
    }
  }

  // Lazy-load the catalog the first time the pane mounts.
  onMount(ensureCatalog);

  async function play(game: Game) {
    const urls = fileUrls(game.fileLink);
    if (!urls.length || loadingGame()) return;
    setLoadingGame(game);
    setLibraryError('');
    try {
      const data = await fetchFirst(urls);
      await loadFile(data, basename(game.fileLink));
      // Remember what got mounted so the row stays highlighted until it's
      // ejected or replaced (captured from the resulting media name, which
      // differs from the .zip filename after unzip).
      const kind = game.isDisk ? 'disk' : 'tape';
      setMounted({ game, name: kind === 'disk' ? currentDiskName() : tapeName(), kind });
    } catch (err) {
      console.warn(`Failed to load "${game.title}":`, err);
      setLibraryError(`Could not download "${game.title}".`);
    } finally {
      setLoadingGame(null);
    }
  }

  // Clear the "mounted" highlight once that tape/disk is ejected or replaced.
  createEffect(() => {
    const m = mounted();
    if (!m) return;
    const live = m.kind === 'disk' ? currentDiskName() : tapeName();
    if (live !== m.name) setMounted(null);
  });

  return (
    <Pane id="game-library-panel" label="Software Library">
      <div class="library-search">
        <input
          type="text"
          class="library-search-input"
          placeholder="Search software…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>

      <Show when={libraryError()}>
        <div class="library-status library-error">{libraryError()}</div>
      </Show>
      <Show when={libraryLoading()}>
        <div class="library-status">Loading catalog…</div>
      </Show>

      <Show when={catalog() && !libraryLoading()}>
        <Show
          when={query().trim()}
          fallback={<div class="library-status">Type to search {games().length.toLocaleString()} titles…</div>}
        >
        <div class="library-list">
          <For each={filtered()} fallback={<div class="library-status">No matches.</div>}>
            {(game) => (
              <div
                class={`library-row${loadingGame() === game ? ' loading' : ''}${mounted()?.game === game ? ' mounted' : ''}`}
                onClick={() => play(game)}
                title={`${game.title}${game.publisher ? ` — ${game.publisher}` : ''}${game.isDisk ? ' (disk)' : ''}`}
              >
                <span class="library-title">
                  {game.title}{game.year ? ` (${game.year})` : ''}{game.isDisk ? ' 💾' : ''}
                </span>
                <Show when={game.publisher}>
                  <span class="library-pub">{shortPublisher(game.publisher)}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
        </Show>
      </Show>
    </Pane>
  );
}
