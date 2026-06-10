import { createMemo, createSignal, createEffect, onMount, Show, For } from 'solid-js';
import { HiOutlineEllipsisVertical, HiOutlinePlay } from 'solid-icons/hi';
import { Pane } from '@/components/Pane.tsx';
import { DropDownMenuButton, type MenuItem } from '@/components/DropDownMenuButton.tsx';
import { loadFile } from '@/emulator.ts';
import { tapeName } from '@/state/tape-state.ts';
import { currentDiskName } from '@/state/disk-state.ts';
import {
  fetchCatalog, fileUrls, basename, resolveGame, parseLibraryQuery, type Game,
} from '@/library/catalog.ts';
import { renderScrToCanvas } from '@/library/scr-render.ts';
import {
  catalog, setCatalog, query, setQuery,
  libraryLoading, setLibraryLoading, libraryError, setLibraryError,
  loadingGame, setLoadingGame, mounted, setMounted,
  genreFilter, toggleGenreFilter, toggleGenreGroup, clearGenreFilter,
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

/** Expanded detail row: screenshot (rendered from the SCR) with the publisher
 *  name below it. */
function GameDetail(props: { game: Game }) {
  let canvasRef: HTMLCanvasElement | undefined;
  const [shot, setShot] = createSignal<'none' | 'loading' | 'ok' | 'error'>(
    props.game.screen ? 'loading' : 'none',
  );

  onMount(async () => {
    if (!props.game.screen) return;
    try {
      const data = await fetchFirst(fileUrls(props.game.screen));
      setShot(canvasRef && renderScrToCanvas(data, canvasRef) ? 'ok' : 'error');
    } catch {
      setShot('error');
    }
  });

  return (
    <div class="library-detail">
      <div class="library-shot">
        <canvas ref={canvasRef} class="library-shot-canvas" classList={{ hidden: shot() !== 'ok' }} />
        <Show when={shot() !== 'ok'}>
          <div class="library-shot-empty">{shot() === 'loading' ? 'Loading…' : 'No screenshot'}</div>
        </Show>
      </div>
      <Show when={props.game.publisher}>
        <div class="library-detail-pub">{props.game.publisher}</div>
      </Show>
    </div>
  );
}

export function GameLibraryPane() {
  const [selected, setSelected] = createSignal<Game | null>(null);

  // Resolve the compact entries once, when the catalog arrives.
  const games = createMemo<Game[]>(() => {
    const cat = catalog();
    return cat ? cat.games.map(g => resolveGame(g, cat)) : [];
  });

  // Active when any constraint is set: free text, year:/publisher: tokens, or a
  // genre filter. Inactive → the list shows the "type to search" hint instead.
  const isActive = createMemo(() => {
    const { text, year, publisher } = parseLibraryQuery(query());
    return text !== '' || year !== null || publisher !== '' || genreFilter().size > 0;
  });

  // Title text + year:/publisher: tokens + genre filter, capped for render perf.
  const filtered = createMemo<Game[]>(() => {
    const { text, year, publisher } = parseLibraryQuery(query());
    const genres = genreFilter();
    if (!text && year === null && !publisher && genres.size === 0) return [];
    const out: Game[] = [];
    for (const g of games()) {
      if (text && !g.title.toLowerCase().includes(text)) continue;
      if (year !== null && g.year !== year) continue;
      if (publisher && !g.publisher.toLowerCase().includes(publisher)) continue;
      if (genres.size > 0 && !genres.has(g.genre)) continue;
      out.push(g);
      if (out.length >= RESULT_LIMIT) break;
    }
    return out;
  });

  // Genre filter menu. ZXDB genres are "Category: Sub-type" strings (e.g.
  // "Arcade Game: Action"); we group them so the part before ": " is a
  // top-level category and the parts after live in its flyout. Clicking a
  // category toggles the whole group; hovering it picks individual sub-types.
  // Flat genres (no ": ") are plain top-level items. A Clear item leads when
  // anything is selected.
  const filterItems = createMemo<MenuItem[]>(() => {
    const cat = catalog();
    const sel = genreFilter();
    const items: MenuItem[] = [];
    if (sel.size > 0) {
      items.push({ value: '__clear', label: `Clear filter (${sel.size})` });
      items.push({ value: '__sep', label: '', separator: true });
    }
    if (!cat) return items;

    // Group by the text before ": ". `bare` is a genre equal to the prefix with
    // no sub-type (e.g. "Compilation" alongside "Compilation: Games").
    const groups = new Map<string, { bare?: string; subs: { sub: string; value: string }[] }>();
    for (const g of cat.genres) {
      const i = g.indexOf(': ');
      const prefix = i >= 0 ? g.slice(0, i) : g;
      let grp = groups.get(prefix);
      if (!grp) { grp = { subs: [] }; groups.set(prefix, grp); }
      if (i >= 0) grp.subs.push({ sub: g.slice(i + 2), value: g });
      else grp.bare = g;
    }

    for (const prefix of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
      const grp = groups.get(prefix)!;
      // No sub-types → a plain checkable genre.
      if (grp.subs.length === 0) {
        items.push({ value: `g:${grp.bare}`, label: prefix, checked: sel.has(grp.bare!) });
        continue;
      }
      const children: MenuItem[] = [];
      const members: string[] = [];
      if (grp.bare) {
        members.push(grp.bare);
        children.push({ value: `g:${grp.bare}`, label: '(general)', checked: sel.has(grp.bare) });
      }
      for (const { sub, value } of grp.subs.sort((a, b) => a.sub.localeCompare(b.sub))) {
        members.push(value);
        children.push({ value: `g:${value}`, label: sub, checked: sel.has(value) });
      }
      const on = members.filter(m => sel.has(m)).length;
      items.push({
        value: `grp:${prefix}`,
        label: prefix,
        checked: on === members.length,
        indeterminate: on > 0 && on < members.length,
        children,
      });
    }
    return items;
  });

  function onFilterSelect(value: string) {
    if (value === '__clear') { clearGenreFilter(); return; }
    if (value.startsWith('g:')) { toggleGenreFilter(value.slice(2)); return; }
    if (value.startsWith('grp:')) {
      const prefix = value.slice(4);
      const cat = catalog();
      if (!cat) return;
      toggleGenreGroup(cat.genres.filter(g => g === prefix || g.startsWith(`${prefix}: `)));
    }
  }

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
          title="Search by title. Also: year:1987, publisher:ocean"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <div class="library-search-menu">
          <DropDownMenuButton
            size="sm"
            icon={<HiOutlineEllipsisVertical />}
            title="Filter by genre"
            items={filterItems()}
            onSelect={onFilterSelect}
          />
        </div>
      </div>

      <Show when={libraryError()}>
        <div class="library-status library-error">{libraryError()}</div>
      </Show>
      <Show when={libraryLoading()}>
        <div class="library-status">Loading catalog…</div>
      </Show>

      <Show when={catalog() && !libraryLoading()}>
        <Show when={isActive()}>
          <div class="library-list">
            <For each={filtered()} fallback={<div class="library-status">No matches.</div>}>
              {(game) => (
                <div class="library-entry">
                  <div
                    class={`library-row${loadingGame() === game ? ' loading' : ''}${mounted()?.game === game ? ' mounted' : ''}${selected() === game ? ' selected' : ''}`}
                    onClick={() => setSelected(selected() === game ? null : game)}
                    title={`${game.title}${game.publisher ? ` — ${game.publisher}` : ''}${game.isDisk ? ' (disk)' : ''}`}
                  >
                    <span class="library-title">
                      {game.title}{game.isDisk ? ' 💾' : ''}
                    </span>
                    <span
                      class="library-play"
                      title="Load"
                      onClick={(e) => { e.stopPropagation(); play(game); }}
                    >
                      <HiOutlinePlay />
                    </span>
                  </div>
                  <Show when={selected() === game}>
                    <GameDetail game={game} />
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
