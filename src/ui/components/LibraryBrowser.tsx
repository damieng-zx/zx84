import { createMemo, createSignal, createEffect, onMount, Show, For } from 'solid-js';
import { HiOutlineEllipsisVertical, HiOutlinePlay } from 'solid-icons/hi';
import { DropDownMenuButton, type MenuItem } from '@/ui/components/DropDownMenuButton.tsx';
import { loadFile, ejectDisk } from '@/shell/media.ts';
import { switchModel, autoBootLoad } from '@/shell/lifecycle.ts';
import { setStatus } from '@/shell/context.ts';
import { currentModel, cartridgeName } from '@/state/machine-state.ts';
import { tapeName } from '@/state/tape-state.ts';
import { currentDiskName } from '@/state/disk-state.ts';
import {
  fetchCatalog, fileUrls, basename, resolveGame, parseLibraryQuery, planLoad, gameNeeds, type Game,
} from '@/library/catalog.ts';
import { renderScrToCanvas } from '@/library/scr-render.ts';
import {
  catalog, setCatalog, query, setQuery,
  libraryLoading, setLibraryLoading, libraryError, setLibraryError,
  loadingGame, setLoadingGame, mounted, setMounted,
  genreFilter, toggleGenreFilter, toggleGenreGroup,
  formatFilter, toggleFormatFilter, toggleFormatGroup, type FormatReq,
} from '@/state/library-state.ts';

// "Format" filter options, in display order — maps a gameNeeds() tag to its
// label. 'rom' (a ZX Interface 2 cartridge) takes priority over every other
// tag; the rest are the minimum machine a title needs to run.
const FORMAT_OPTIONS: { req: FormatReq; label: string }[] = [
  { req: '48', label: '48K' },
  { req: '128', label: '128K' },
  { req: '+3', label: '+3' },
  { req: 'rom', label: 'ROM' },
];

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

// Third (top) level of the genre filter. ZXDB top-level prefixes ("Arcade
// Game", "Utility", "Demoscene", …) are bucketed into a handful of broad
// super-categories, in this display order. Any prefix not listed here falls
// into a trailing "Other" bucket so new catalog genres never silently vanish.
const SUPER_CATEGORIES: { name: string; prefixes: string[] }[] = [
  { name: 'Games', prefixes: ['Adventure Game', 'Arcade Game', 'Casual Game', 'Game', 'Puzzle Game', 'Sport Game', 'Strategy Game'] },
  { name: 'Serious', prefixes: ['Emulator', 'General', 'Programming', 'Utility'] },
  { name: 'Fan', prefixes: ['Advertising', 'Animation', 'Demoscene', 'E-Book', 'Electronic Magazine', 'Tech Demo'] },
  { name: 'Compilations', prefixes: ['Box Set', 'Compilation', 'Covertape'] },
];

/** The ": "-prefix of a genre string ("Arcade Game: Action" → "Arcade Game"). */
function genrePrefix(g: string): string {
  const i = g.indexOf(': ');
  return i >= 0 ? g.slice(0, i) : g;
}

/** Row badge/tooltip label for a gameNeeds() tag ('48' shows no badge at all). */
function needsLabel(needs: '48' | '128' | '+3' | 'rom'): string {
  return needs === '+3' ? '+3' : needs === 'rom' ? 'ROM' : '128';
}

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
      <Show when={props.game.publisher || props.game.year}>
        <div class="library-detail-pub">
          <span class="library-detail-pubname">{props.game.publisher}</span>
          <Show when={props.game.year}>
            <span class="library-detail-year">{props.game.year}</span>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** The software library browser — search box, genre filter, results list and
 *  expandable detail. Embedded in the Load/Save pane, toggled by its Library
 *  button (it has no Pane chrome of its own). */
export function LibraryBrowser() {
  const [selected, setSelected] = createSignal<Game | null>(null);

  // Resolve the compact entries once, when the catalog arrives.
  const games = createMemo<Game[]>(() => {
    const cat = catalog();
    return cat ? cat.games.map(g => resolveGame(g, cat)) : [];
  });

  // Active when any constraint is set: free text, year:/publisher: tokens, or a
  // genre filter. Inactive → the list shows nothing (just the search box).
  const isActive = createMemo(() => {
    const { text, negTerms, yearMin, yearMax, publisher } = parseLibraryQuery(query());
    return text !== '' || negTerms.length > 0 || yearMin !== null || yearMax !== null || publisher !== '' || genreFilter().size > 0 || formatFilter().size > 0;
  });

  // Positive title text + `-word` exclusions + year:/publisher: tokens + genre +
  // "Format" filters, capped for render perf.
  const filtered = createMemo<Game[]>(() => {
    const { text, negTerms, yearMin, yearMax, publisher } = parseLibraryQuery(query());
    const genres = genreFilter();
    const formats = formatFilter();
    const hasYear = yearMin !== null || yearMax !== null;
    if (!text && negTerms.length === 0 && !hasYear && !publisher && genres.size === 0 && formats.size === 0) return [];
    const out: Game[] = [];
    for (const g of games()) {
      const title = g.title.toLowerCase();
      if (text && !title.includes(text)) continue;
      if (negTerms.length > 0 && negTerms.some(n => title.includes(n))) continue;
      if (hasYear && (g.year === null || (yearMin !== null && g.year < yearMin) || (yearMax !== null && g.year > yearMax))) continue;
      if (publisher && !g.publisher.toLowerCase().includes(publisher)) continue;
      if (genres.size > 0 && !genres.has(g.genre)) continue;
      if (formats.size > 0 && !formats.has(gameNeeds(g))) continue;
      out.push(g);
      if (out.length >= RESULT_LIMIT) break;
    }
    return out;
  });

  // Genre filter menu — three levels. ZXDB genres are "Category: Sub-type"
  // strings (e.g. "Arcade Game: Action"). The part after ": " is the innermost
  // flyout (sub-type), the part before is the middle category, and categories
  // are bucketed into SUPER_CATEGORIES at the top. Clicking any level toggles
  // the whole subtree under it; hovering drills in. Counts roll up so a partly
  // selected branch shows a dash.
  const filterItems = createMemo<MenuItem[]>(() => {
    // "Format" filter — always available, independent of the catalog.
    const fmt = formatFilter();
    const reqChildren: MenuItem[] = FORMAT_OPTIONS.map(o => ({
      value: `req:${o.req}`, label: o.label, checked: fmt.has(o.req),
    }));
    const reqOn = FORMAT_OPTIONS.filter(o => fmt.has(o.req)).length;
    const head: MenuItem[] = [
      {
        value: 'reqgrp', label: 'Format',
        checked: reqOn === FORMAT_OPTIONS.length,
        indeterminate: reqOn > 0 && reqOn < FORMAT_OPTIONS.length,
        children: reqChildren,
      },
      { value: '_sep', label: '', separator: true },
      { value: '_genre', label: 'Genre', heading: true },
    ];

    const cat = catalog();
    const sel = genreFilter();
    if (!cat) return head;

    // Second level: group genres by their ": " prefix. `bare` is a genre equal
    // to the prefix with no sub-type (e.g. "Compilation" alongside
    // "Compilation: Games").
    const groups = new Map<string, { bare?: string; subs: { sub: string; value: string }[] }>();
    for (const g of cat.genres) {
      const i = g.indexOf(': ');
      const prefix = i >= 0 ? g.slice(0, i) : g;
      let grp = groups.get(prefix);
      if (!grp) { grp = { subs: [] }; groups.set(prefix, grp); }
      if (i >= 0) grp.subs.push({ sub: g.slice(i + 2), value: g });
      else grp.bare = g;
    }

    // Build the middle-level menu item for one prefix, plus the flat list of
    // genre strings it covers (used to roll counts up to the super-category).
    function buildGroup(prefix: string): { item: MenuItem; members: string[] } {
      const grp = groups.get(prefix)!;
      // No sub-types → a plain checkable genre.
      if (grp.subs.length === 0) {
        return {
          item: { value: `g:${grp.bare}`, label: prefix, checked: sel.has(grp.bare!) },
          members: [grp.bare!],
        };
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
      return {
        item: {
          value: `grp:${prefix}`,
          label: prefix,
          checked: on === members.length,
          indeterminate: on > 0 && on < members.length,
          children,
        },
        members,
      };
    }

    // Assign each present prefix to its super-category bucket, in the declared
    // order; unknown prefixes collect into a trailing "Other" bucket.
    const buckets = SUPER_CATEGORIES.map(s => ({ name: s.name, prefixes: [] as string[] }));
    const other: string[] = [];
    for (const prefix of groups.keys()) {
      const idx = SUPER_CATEGORIES.findIndex(s => s.prefixes.includes(prefix));
      if (idx >= 0) buckets[idx].prefixes.push(prefix); else other.push(prefix);
    }
    if (other.length) buckets.push({ name: 'Other', prefixes: other });

    const items: MenuItem[] = [];
    for (const bucket of buckets) {
      const prefixes = bucket.prefixes.sort((a, b) => a.localeCompare(b));
      if (prefixes.length === 0) continue;
      const children: MenuItem[] = [];
      const members: string[] = [];
      for (const prefix of prefixes) {
        const built = buildGroup(prefix);
        children.push(built.item);
        members.push(...built.members);
      }
      const on = members.filter(m => sel.has(m)).length;
      items.push({
        value: `sup:${bucket.name}`,
        label: bucket.name,
        checked: on === members.length,
        indeterminate: on > 0 && on < members.length,
        children,
      });
    }
    return [...head, ...items];
  });

  function onFilterSelect(value: string) {
    if (value === 'reqgrp') { toggleFormatGroup(); return; }
    if (value.startsWith('req:')) { toggleFormatFilter(value.slice(4) as FormatReq); return; }
    if (value.startsWith('g:')) { toggleGenreFilter(value.slice(2)); return; }
    const cat = catalog();
    if (!cat) return;
    if (value.startsWith('grp:')) {
      const prefix = value.slice(4);
      toggleGenreGroup(cat.genres.filter(g => genrePrefix(g) === prefix));
      return;
    }
    if (value.startsWith('sup:')) {
      const name = value.slice(4);
      const sup = SUPER_CATEGORIES.find(s => s.name === name);
      // Named super → its declared prefixes; "Other" → every prefix that isn't
      // claimed by a named super.
      const inBucket = sup
        ? (g: string) => sup.prefixes.includes(genrePrefix(g))
        : (g: string) => !SUPER_CATEGORIES.some(s => s.prefixes.includes(genrePrefix(g)));
      toggleGenreGroup(cat.genres.filter(inBucket));
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

  // Lazy-load the catalog the first time the browser mounts (i.e. is shown).
  onMount(ensureCatalog);

  async function play(game: Game) {
    const plan = planLoad(game, currentModel());
    if (!plan || loadingGame()) return;
    const urls = fileUrls(plan.link);
    if (!urls.length) return;
    // Re-playing the game that is already mounted/active is a Side B /
    // next-part multi-load: the multi-file picker opens as usual (inside
    // loadFile), but we mount the chosen file IN PLACE without resetting —
    // so the running program keeps going and reads the freshly-swapped media.
    const remountOnly = mounted()?.game === game;
    setLoadingGame(game);
    setLibraryError('');
    try {
      const data = await fetchFirst(urls);
      // Switch to the model this load needs (if any), mount the media, then
      // reset + kick the loader (Enter on the 128K/+3 menu, or 48K ROM jump) —
      // unless this is an in-place remount, where we mount and leave the
      // machine running. (An active game already runs on the right model, so
      // the model-switch guard below never trips in the remount case.)
      if (plan.target !== currentModel()) await switchModel(plan.target);
      await loadFile(data, basename(plan.link));
      // A snapshot restores running state itself, and a ROM cartridge self-boots
      // on insert (loadFile's .rom routing already resets+starts the machine) —
      // neither needs a loader kick, and neither should eject a mounted disk.
      const isSnapshot = plan.boot === 'snapshot';
      const isRom = plan.boot === 'rom';
      // A tape-only game on a +3/+2A must not find a disk in A: — the boot
      // menu's Loader boots the disk in preference to the tape. Eject any
      // mounted disk so the Loader falls through to the cassette loader.
      if (!remountOnly && !isSnapshot && !isRom && !plan.isDisk && currentDiskName()) ejectDisk(0);
      // Capture the mounted media name before the boot reset so the row stays
      // highlighted until it's ejected or replaced.
      if (isRom) {
        setMounted({ game, name: cartridgeName(), kind: 'rom' });
      } else {
        const kind = plan.isDisk ? 'disk' : 'tape';
        setMounted({ game, name: kind === 'disk' ? currentDiskName() : tapeName(), kind });
      }
      // "Loading" (not "loaded"): the file is mounted and the loader kicked, but
      // the program itself is only now starting to load. Overrides the media
      // manager's "…loaded" message and shows the clean title, not the filename.
      const source = isRom ? 'cartridge' : plan.isDisk ? 'disk' : isSnapshot ? 'snapshot' : 'tape';
      setStatus(`Loading ${game.title} from ${source}`);
      if (!remountOnly && plan.boot !== 'snapshot' && plan.boot !== 'rom') autoBootLoad(plan.boot);
    } catch (err) {
      console.warn(`Failed to load "${game.title}":`, err);
      setLibraryError(`Could not download "${game.title}".`);
    } finally {
      setLoadingGame(null);
    }
  }

  // Clear the "mounted" highlight once that tape/disk/cartridge is ejected or replaced.
  createEffect(() => {
    const m = mounted();
    if (!m) return;
    const live = m.kind === 'disk' ? currentDiskName() : m.kind === 'rom' ? cartridgeName() : tapeName();
    if (live !== m.name) setMounted(null);
  });

  return (
    <div class="library-browser">
      <div class="library-search">
        <input
          type="search"
          class="library-search-input"
          placeholder="Search software…"
          title="Search by title. Also: -word (exclude), year:1987, year:1983-1989, publisher:ocean"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <div class="library-search-menu">
          <DropDownMenuButton
            size="sm"
            icon={<HiOutlineEllipsisVertical />}
            title="Filter by required machine or genre"
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

      <Show when={catalog() && !libraryLoading() && isActive()}>
        <div class="library-list">
          <For each={filtered()} fallback={<div class="library-status">No matches.</div>}>
            {(game) => (
              <div class="library-entry">
                <div
                  class={`library-row${loadingGame() === game ? ' loading' : ''}${mounted()?.game === game ? ' mounted' : ''}${selected() === game ? ' selected' : ''}`}
                  onClick={() => setSelected(selected() === game ? null : game)}
                  title={`${game.title}${game.publisher ? ` — ${game.publisher}` : ''}${game.isDiskOnly ? ' (disk)' : ''}${gameNeeds(game) !== '48' ? ` · needs ${needsLabel(gameNeeds(game))}` : ''}`}
                >
                  <span class="library-title">
                    {game.title}
                  </span>
                  <Show when={gameNeeds(game) !== '48'}>
                    <span class="library-model">{needsLabel(gameNeeds(game))}</span>
                  </Show>
                  <span
                    class="library-play"
                    title={loadingGame() === game ? 'Requesting file…' : 'Load'}
                    onClick={(e) => { e.stopPropagation(); play(game); }}
                  >
                    <Show when={loadingGame() === game} fallback={<HiOutlinePlay />}>
                      <span class="library-spinner" />
                    </Show>
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
    </div>
  );
}
