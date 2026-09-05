/**
 * SAM Coupé software browser.
 *
 * The ZX80/81 browser's shape, minus the hardware filtering: every SAM title
 * runs on every SAM, so there is no model to switch to and no RAM or graphics
 * board to arrange first. Filtering is genre and media format.
 *
 * Screenshots are ZXDB's SimCoupe screen dumps — `.ssx`, `.ss4` and the `.scr`
 * files that are the same format under a Spectrum-looking name — decoded here
 * rather than handed to an <img>; see `../ssx.ts`. A handful of entries carry
 * an ordinary raster image instead, and those take the <img> path.
 *
 * The catalog publishes every screen an entry has, best first, and this works
 * down the list: the file host serves some of ZXDB's screen extensions and not
 * others, so the best picture is not always the one that arrives.
 */

import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { HiOutlineFunnel, HiOutlinePlay } from 'solid-icons/hi';
import { DropDownMenuButton, type MenuItem } from '@/ui/components/DropDownMenuButton.tsx';
import { basename, fileUrls, parseLibraryQuery } from '@/library/catalog.ts';
import {
  fetchSamCatalog, matchesSamFormatFilter, matchesSamGenreFilter, primarySamFile,
  resolveSamGames, SAM_LIBRARY_FORMATS,
  type RawSamCatalog, type SamGame, type SamLibraryFormat,
} from '@/library/sam-catalog.ts';
import { loadFile } from '@/shell/media.ts';
import { autoBootLoad } from '@/shell/lifecycle.ts';
import { decodeSsx, SSX_HEIGHT, SSX_WIDTH } from '../ssx.ts';

const RESULT_LIMIT = 500;

const FORMAT_LABEL: Record<SamLibraryFormat, string> = { disk: 'Disk', tape: 'Tape' };

/** Genre prefixes gathered under one heading, as the other browsers group them. */
const SUPER_CATEGORIES: { name: string; prefixes: string[] }[] = [
  { name: 'Games', prefixes: ['Adventure Game', 'Arcade Game', 'Casual Game', 'Game', 'Puzzle Game', 'Sport Game', 'Strategy Game'] },
  { name: 'Serious', prefixes: ['Emulator', 'General', 'Programming', 'Utility'] },
  { name: 'Fan', prefixes: ['Advertising', 'Animation', 'Demoscene', 'E-Book', 'Electronic Magazine', 'Tech Demo'] },
  { name: 'Compilations', prefixes: ['Box Set', 'Compilation', 'Covertape'] },
];

function genrePrefix(genre: string): string {
  const separator = genre.indexOf(': ');
  return separator >= 0 ? genre.slice(0, separator) : genre;
}

async function fetchFirst(urls: string[]): Promise<Uint8Array> {
  let last: unknown = new Error('No download URL');
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      last = new Error(`HTTP ${response.status}`);
    } catch (error) { last = error; }
  }
  throw last;
}

const RASTER = /\.(gif|png|jpe?g)$/i;

/** Turn a downloaded screen into an object URL, decoding a SAM screen dump
 *  through a canvas when it is not already an image the browser can show. */
async function screenUrl(link: string, data: Uint8Array): Promise<string> {
  if (RASTER.test(link)) {
    const lower = link.toLowerCase();
    const type = lower.endsWith('.gif') ? 'image/gif' : lower.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return URL.createObjectURL(new Blob([data as unknown as BlobPart], { type }));
  }
  const rgba = decodeSsx(data);
  if (!rgba) throw new Error('Unrecognised screen dump');
  const canvas = document.createElement('canvas');
  canvas.width = SSX_WIDTH;
  canvas.height = SSX_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D context');
  context.putImageData(new ImageData(rgba, SSX_WIDTH, SSX_HEIGHT), 0, 0);
  return canvas.toDataURL('image/png');
}

function Detail(props: { game: SamGame; onPlay: (link: string) => void; busy: boolean }) {
  const [url, setUrl] = createSignal('');
  onMount(async () => {
    for (const link of props.game.screens) {
      try {
        setUrl(await screenUrl(link, await fetchFirst(fileUrls(link))));
        return;
      } catch { /* Try the next candidate; the metadata is useful regardless. */ }
    }
  });
  onCleanup(() => { if (url().startsWith('blob:')) URL.revokeObjectURL(url()); });
  const media = () => props.game.formats.map(format => FORMAT_LABEL[format]).join(' · ');
  return (
    <div class="library-detail">
      <div class="library-detail-pub">
        <span class="library-detail-pubname">
          {props.game.publisher}{props.game.year === null ? '' : ` (${props.game.year})`}
        </span>
        <span class="library-detail-genre">
          {media()}{props.game.genre ? ` · ${props.game.genre.split(': ')[0]}` : ''}
        </span>
      </div>
      {/* A multi-disk release gets a button per disk; one-disk titles are
          launched from the row's own play button and need nothing here. */}
      <Show when={props.game.disks.length > 1}>
        <div class="library-detail-pub">
          <For each={props.game.disks}>
            {disk => (
              <button
                class="library-detail-genre"
                disabled={props.busy}
                onClick={event => { event.stopPropagation(); props.onPlay(disk.link); }}
              >
                {disk.label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="library-shot">
        <Show when={url()} fallback={<div class="library-shot-empty">No screenshot</div>}>
          <img class="library-shot-canvas" src={url()} alt={`${props.game.title} screen`} />
        </Show>
      </div>
    </div>
  );
}

export function SamLibraryBrowser() {
  const [catalog, setCatalog] = createSignal<RawSamCatalog | null>(null);
  const [query, setQuery] = createSignal('');
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [loadingGame, setLoadingGame] = createSignal<SamGame | null>(null);
  const [selected, setSelected] = createSignal<SamGame | null>(null);
  const [formatFilter, setFormatFilter] = createSignal<Set<SamLibraryFormat>>(new Set());
  const [genreFilter, setGenreFilter] = createSignal<Set<string>>(new Set());

  onMount(async () => {
    try { setCatalog(await fetchSamCatalog()); }
    catch { setError('Could not load the SAM Coupé software catalog.'); }
    finally { setLoading(false); }
  });

  const games = createMemo(() => {
    const value = catalog();
    return value ? resolveSamGames(value) : [];
  });

  const filtered = createMemo(() => {
    const parsed = parseLibraryQuery(query());
    const formats = formatFilter();
    const selectedGenres = genreFilter();
    if (!parsed.text && !parsed.negTerms.length && parsed.yearMin === null && parsed.yearMax === null
        && !parsed.publisher && !formats.size && !selectedGenres.size) return [];
    return games().filter(game => {
      const title = game.title.toLowerCase();
      return (!parsed.text || title.includes(parsed.text))
        && !parsed.negTerms.some(term => title.includes(term))
        && (!parsed.publisher || game.publisher.toLowerCase().includes(parsed.publisher))
        && (parsed.yearMin === null || (game.year !== null && game.year >= parsed.yearMin))
        && (parsed.yearMax === null || (game.year !== null && game.year <= parsed.yearMax))
        && matchesSamFormatFilter(game, formats)
        && matchesSamGenreFilter(game, selectedGenres);
    }).slice(0, RESULT_LIMIT);
  });

  const isActive = createMemo(() => {
    const parsed = parseLibraryQuery(query());
    return !!parsed.text || !!parsed.negTerms.length || parsed.yearMin !== null
      || parsed.yearMax !== null || !!parsed.publisher
      || formatFilter().size > 0 || genreFilter().size > 0;
  });

  const genres = createMemo(() => (
    [...new Set(games().map(game => game.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  ));

  const filterItems = createMemo<MenuItem[]>(() => {
    const formats = formatFilter();
    const selectedGenres = genreFilter();
    const selectedFormats = SAM_LIBRARY_FORMATS.filter(format => formats.has(format)).length;
    const items: MenuItem[] = [
      { value: '_format', label: 'Format', heading: true },
      {
        value: 'format',
        label: 'Any format',
        checked: selectedFormats === SAM_LIBRARY_FORMATS.length,
        indeterminate: selectedFormats > 0 && selectedFormats < SAM_LIBRARY_FORMATS.length,
        children: SAM_LIBRARY_FORMATS.map(format => ({
          value: `format:${format}`,
          label: FORMAT_LABEL[format],
          checked: formats.has(format),
        })),
      },
    ];

    // Genres nest prefix → full genre, then a super-category above that, so
    // "Arcade Game" can be ticked whole or opened for its sub-genres.
    const groups = new Map<string, string[]>();
    for (const genre of genres()) {
      const prefix = genrePrefix(genre);
      const list = groups.get(prefix) ?? [];
      list.push(genre);
      groups.set(prefix, list);
    }

    function buildGenreGroup(prefix: string): { item: MenuItem; members: string[] } {
      const members = groups.get(prefix) ?? [];
      const selectedCount = members.filter(member => selectedGenres.has(member)).length;
      const children: MenuItem[] = members.length > 1
        ? members.map(member => ({
          value: `genre:${member}`,
          label: member.slice(prefix.length).replace(/^:\s*/, '') || member,
          checked: selectedGenres.has(member),
        }))
        : [];
      return {
        item: {
          value: children.length ? `genre-group:${prefix}` : `genre:${members[0] ?? prefix}`,
          label: prefix,
          checked: selectedCount === members.length,
          indeterminate: selectedCount > 0 && selectedCount < members.length,
          children: children.length ? children : undefined,
        },
        members,
      };
    }

    const buckets = SUPER_CATEGORIES.map(category => ({ name: category.name, prefixes: [] as string[] }));
    const other: string[] = [];
    for (const prefix of groups.keys()) {
      const index = SUPER_CATEGORIES.findIndex(category => category.prefixes.includes(prefix));
      if (index >= 0) buckets[index].prefixes.push(prefix);
      else other.push(prefix);
    }
    if (other.length) buckets.push({ name: 'Other', prefixes: other });

    const genreItems: MenuItem[] = [];
    for (const bucket of buckets) {
      const prefixes = bucket.prefixes.sort((a, b) => a.localeCompare(b));
      if (!prefixes.length) continue;
      const children: MenuItem[] = [];
      const members: string[] = [];
      for (const prefix of prefixes) {
        const built = buildGenreGroup(prefix);
        children.push(built.item);
        members.push(...built.members);
      }
      const selectedCount = members.filter(member => selectedGenres.has(member)).length;
      genreItems.push({
        value: `genre-super:${bucket.name}`,
        label: bucket.name,
        checked: selectedCount === members.length,
        indeterminate: selectedCount > 0 && selectedCount < members.length,
        children,
      });
    }
    if (genreItems.length) {
      items.push(
        { value: '_separator', label: '', separator: true },
        { value: '_genre', label: 'Genre', heading: true },
        ...genreItems,
      );
    }
    return items;
  });

  function toggleGenres(members: readonly string[]): void {
    const next = new Set(genreFilter());
    const allSelected = members.length > 0 && members.every(member => next.has(member));
    for (const member of members) {
      if (allSelected) next.delete(member);
      else next.add(member);
    }
    setGenreFilter(next);
  }

  function toggleFilter(value: string): void {
    if (value === 'format') {
      const next = new Set(formatFilter());
      const allSelected = SAM_LIBRARY_FORMATS.every(format => next.has(format));
      for (const format of SAM_LIBRARY_FORMATS) {
        if (allSelected) next.delete(format);
        else next.add(format);
      }
      setFormatFilter(next);
      return;
    }
    if (value.startsWith('format:')) {
      const format = value.slice('format:'.length) as SamLibraryFormat;
      const next = new Set(formatFilter());
      if (next.has(format)) next.delete(format);
      else next.add(format);
      setFormatFilter(next);
      return;
    }
    if (value.startsWith('genre:')) {
      toggleGenres([value.slice('genre:'.length)]);
      return;
    }
    if (value.startsWith('genre-group:')) {
      const prefix = value.slice('genre-group:'.length);
      toggleGenres(genres().filter(genre => genrePrefix(genre) === prefix));
      return;
    }
    if (value.startsWith('genre-super:')) {
      const name = value.slice('genre-super:'.length);
      const category = SUPER_CATEGORIES.find(candidate => candidate.name === name);
      const inBucket = category
        ? (genre: string) => category.prefixes.includes(genrePrefix(genre))
        : (genre: string) => !SUPER_CATEGORIES.some(candidate => candidate.prefixes.includes(genrePrefix(genre)));
      toggleGenres(genres().filter(inBucket));
    }
  }

  /**
   * Download, mount and boot one file.
   *
   * The SAM's media service decides disk vs tape from the content, so nothing
   * here has to know which it handed over. A disk then boots itself: the shell
   * resets the machine and holds F9 down for it, which is what a SAM owner
   * does at the boot screen. A tape is left mounted for the program's own
   * LOAD, exactly as a cassette would be.
   */
  async function play(game: SamGame, link = primarySamFile(game)): Promise<void> {
    if (loadingGame() || !link) return;
    setLoadingGame(game);
    setError('');
    try {
      await loadFile(await fetchFirst(fileUrls(link)), basename(link));
      if (game.disks.some(disk => disk.link === link)) autoBootLoad('disk');
    } catch {
      setError(`Could not download "${game.title}".`);
    } finally { setLoadingGame(null); }
  }

  return (
    <div class="library-browser">
      <div class="library-search">
        <div class="library-search-field">
          <input
            class="library-search-input"
            type="search"
            placeholder="Search SAM Coupé software…"
            value={query()}
            onInput={event => setQuery(event.currentTarget.value)}
          />
          <Show when={query()}>
            <button class="library-search-clear" onClick={() => setQuery('')} aria-label="Clear search">×</button>
          </Show>
        </div>
        <Show when={catalog()}>
          <div class="library-search-menu" classList={{ active: formatFilter().size > 0 || genreFilter().size > 0 }}>
            <DropDownMenuButton
              size="sm"
              icon={<HiOutlineFunnel />}
              title="Filter software"
              items={filterItems()}
              onSelect={toggleFilter}
            />
          </div>
        </Show>
      </div>
      <Show when={error()}><div class="library-status library-error">{error()}</div></Show>
      <Show when={loading()}><div class="library-status">Loading catalog…</div></Show>
      <Show when={catalog() && isActive()}>
        <div class="library-list">
          <For each={filtered()} fallback={<div class="library-status">No matches.</div>}>
            {game => <div class="library-entry">
              <div
                class={`library-row${selected() === game ? ' selected' : ''}${loadingGame() === game ? ' loading' : ''}`}
                onClick={() => setSelected(selected() === game ? null : game)}
              >
                <span class="library-title">{game.title}</span>
                <a
                  class="library-info"
                  href={`https://spectrumcomputing.co.uk/entry/${game.id}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={event => event.stopPropagation()}
                ><span class="library-info-i">i</span></a>
                <span class="library-play" onClick={event => { event.stopPropagation(); void play(game); }}>
                  <Show when={loadingGame() === game} fallback={<HiOutlinePlay />}><span class="library-spinner" /></Show>
                </span>
              </div>
              <Show when={selected() === game}>
                <Detail
                  game={game}
                  busy={loadingGame() !== null}
                  onPlay={link => void play(game, link)}
                />
              </Show>
            </div>}
          </For>
        </div>
      </Show>
    </div>
  );
}
