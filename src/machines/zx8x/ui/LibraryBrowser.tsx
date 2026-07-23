import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { HiOutlineFunnel, HiOutlinePlay } from 'solid-icons/hi';
import { DropDownMenuButton, type MenuItem } from '@/ui/components/DropDownMenuButton.tsx';
import { basename, fileUrls, parseLibraryQuery } from '@/library/catalog.ts';
import {
  fetchZx8xCatalog, matchesZx8xGenreFilter, matchesZx8xHardwareFilters, resolveZx8xGamesForModel,
  type RawZx8xCatalog, type Zx8xGame,
} from '@/library/zx8x-catalog.ts';
import { zx8xLaunchHardware } from '@/library/zx8x-hardware.ts';
import { loadFile } from '@/shell/media.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import { currentModel } from '@/state/machine-state.ts';
import * as settings from '@/store/settings.ts';

const RESULT_LIMIT = 500;

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

function Detail(props: { game: Zx8xGame }) {
  const [url, setUrl] = createSignal('');
  onMount(async () => {
    if (!props.game.screen) return;
    try {
      const data = await fetchFirst(fileUrls(props.game.screen));
      const lower = props.game.screen.toLowerCase();
      const type = lower.endsWith('.gif') ? 'image/gif' : lower.endsWith('.png') ? 'image/png' : 'image/jpeg';
      setUrl(URL.createObjectURL(new Blob([data as unknown as BlobPart], { type })));
    } catch { /* The metadata remains useful without a screenshot. */ }
  });
  onCleanup(() => { if (url()) URL.revokeObjectURL(url()); });
  const graphics = () => props.game.enhancedGraphics.map(value => value.replace(/^ZX81\s+(?:Hi-res:\s*)?/, '')).join(', ');
  const hardware = () => [
    props.game.model.toUpperCase(),
    props.game.ramKb === null ? '' : `${props.game.ramKb}KB`,
    graphics() || (props.game.hiRes ? ({
      udg: 'UDG', udg128: 'UDG-128', wrx: 'WRX', memotech: 'Memotech HRG',
      quicksilva: 'QuickSilva HRG', software: 'Software hi-res',
    } as const)[props.game.hiRes] : ''),
  ].filter(Boolean).join(' · ');
  return (
    <div class="library-detail">
      <div class="library-detail-pub">
        <span class="library-detail-pubname">{props.game.publisher}{props.game.year === null ? '' : ` (${props.game.year})`}</span>
        <span class="library-detail-genre">{hardware()}{props.game.genre ? ` · ${props.game.genre.split(': ')[0]}` : ''}</span>
      </div>
      <div class="library-shot">
        <Show when={url()} fallback={<div class="library-shot-empty">No screenshot</div>}>
          <img class="library-shot-canvas" src={url()} alt={`${props.game.title} screen`} />
        </Show>
      </div>
    </div>
  );
}

export function Zx8xLibraryBrowser() {
  const [catalog, setCatalog] = createSignal<RawZx8xCatalog | null>(null);
  const [query, setQuery] = createSignal('');
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [loadingGame, setLoadingGame] = createSignal<Zx8xGame | null>(null);
  const [selected, setSelected] = createSignal<Zx8xGame | null>(null);
  const [graphicsFilter, setGraphicsFilter] = createSignal<Set<string>>(new Set());
  const [memoryFilter, setMemoryFilter] = createSignal<Set<number>>(new Set());
  const [genreFilter, setGenreFilter] = createSignal<Set<string>>(new Set());

  onMount(async () => {
    try { setCatalog(await fetchZx8xCatalog()); }
    catch { setError('Could not load the ZX80/ZX81 software catalog.'); }
    finally { setLoading(false); }
  });

  const games = createMemo(() => {
    const value = catalog();
    const model = currentModel();
    return value && (model === 'zx80' || model === 'zx81')
      ? resolveZx8xGamesForModel(value, model)
      : [];
  });

  const filtered = createMemo(() => {
    const parsed = parseLibraryQuery(query());
    const selectedGraphics = graphicsFilter();
    const selectedMemory = memoryFilter();
    const selectedGenres = genreFilter();
    if (!parsed.text && !parsed.negTerms.length && parsed.yearMin === null && parsed.yearMax === null
        && !parsed.publisher && !selectedGraphics.size && !selectedMemory.size && !selectedGenres.size) return [];
    return games().filter(game => {
      const title = game.title.toLowerCase();
      return (!parsed.text || title.includes(parsed.text))
        && !parsed.negTerms.some(term => title.includes(term))
        && (!parsed.publisher || game.publisher.toLowerCase().includes(parsed.publisher))
        && (parsed.yearMin === null || (game.year !== null && game.year >= parsed.yearMin))
        && (parsed.yearMax === null || (game.year !== null && game.year <= parsed.yearMax))
        && matchesZx8xHardwareFilters(game, selectedGraphics, selectedMemory)
        && matchesZx8xGenreFilter(game, selectedGenres);
    }).slice(0, RESULT_LIMIT);
  });

  const isActive = createMemo(() => {
    const parsed = parseLibraryQuery(query());
    return !!parsed.text || !!parsed.negTerms.length || parsed.yearMin !== null || parsed.yearMax !== null
      || !!parsed.publisher || graphicsFilter().size > 0 || memoryFilter().size > 0 || genreFilter().size > 0;
  });

  const videoFeatures = createMemo(() => (
    [...new Set(games().flatMap(game => game.enhancedGraphics))].sort((a, b) => a.localeCompare(b))
  ));

  const genres = createMemo(() => (
    [...new Set(games().map(game => game.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  ));

  const filterItems = createMemo<MenuItem[]>(() => {
    const selectedGraphics = graphicsFilter();
    const selectedMemory = memoryFilter();
    const selectedGenres = genreFilter();
    const features = videoFeatures();
    const selectedVideoCount = features.filter(feature => selectedGraphics.has(feature)).length;
    const selectedMemoryCount = [1, 16].filter(ramKb => selectedMemory.has(ramKb)).length;
    const items: MenuItem[] = [];
    if (features.length) items.push({
      value: 'video',
      label: 'Video',
      checked: selectedVideoCount === features.length,
      indeterminate: selectedVideoCount > 0 && selectedVideoCount < features.length,
      children: features.map(feature => ({
        value: `video:${feature}`,
        label: feature.replace(/^ZX81\s+/, ''),
        checked: selectedGraphics.has(feature),
      })),
    });
    items.push({
      value: 'memory',
      label: 'Memory',
      checked: selectedMemoryCount === 2,
      indeterminate: selectedMemoryCount > 0 && selectedMemoryCount < 2,
      children: [1, 16].map(ramKb => ({
        value: `memory:${ramKb}`,
        label: `${ramKb}KB`,
        checked: selectedMemory.has(ramKb),
      })),
    });

    const groups = new Map<string, { bare?: string; subs: { sub: string; value: string }[] }>();
    for (const genre of genres()) {
      const separator = genre.indexOf(': ');
      const prefix = separator >= 0 ? genre.slice(0, separator) : genre;
      let group = groups.get(prefix);
      if (!group) { group = { subs: [] }; groups.set(prefix, group); }
      if (separator >= 0) group.subs.push({ sub: genre.slice(separator + 2), value: genre });
      else group.bare = genre;
    }

    function buildGenreGroup(prefix: string): { item: MenuItem; members: string[] } {
      const group = groups.get(prefix)!;
      if (group.subs.length === 0) {
        return {
          item: { value: `genre:${group.bare}`, label: prefix, checked: selectedGenres.has(group.bare!) },
          members: [group.bare!],
        };
      }
      const children: MenuItem[] = [];
      const members: string[] = [];
      if (group.bare) {
        members.push(group.bare);
        children.push({ value: `genre:${group.bare}`, label: '(general)', checked: selectedGenres.has(group.bare) });
      }
      for (const { sub, value } of group.subs.sort((a, b) => a.sub.localeCompare(b.sub))) {
        members.push(value);
        children.push({ value: `genre:${value}`, label: sub, checked: selectedGenres.has(value) });
      }
      const selectedCount = members.filter(member => selectedGenres.has(member)).length;
      return {
        item: {
          value: `genre-group:${prefix}`,
          label: prefix,
          checked: selectedCount === members.length,
          indeterminate: selectedCount > 0 && selectedCount < members.length,
          children,
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

  function toggleGenreGroup(members: readonly string[]): void {
    const next = new Set(genreFilter());
    const allSelected = members.length > 0 && members.every(member => next.has(member));
    for (const member of members) {
      if (allSelected) next.delete(member);
      else next.add(member);
    }
    setGenreFilter(next);
  }

  function toggleFilter(value: string): void {
    if (value.startsWith('genre:')) {
      const genre = value.slice('genre:'.length);
      const next = new Set(genreFilter());
      if (next.has(genre)) next.delete(genre);
      else next.add(genre);
      setGenreFilter(next);
      return;
    }
    if (value.startsWith('genre-group:')) {
      const prefix = value.slice('genre-group:'.length);
      toggleGenreGroup(genres().filter(genre => genrePrefix(genre) === prefix));
      return;
    }
    if (value.startsWith('genre-super:')) {
      const name = value.slice('genre-super:'.length);
      const category = SUPER_CATEGORIES.find(candidate => candidate.name === name);
      const inBucket = category
        ? (genre: string) => category.prefixes.includes(genrePrefix(genre))
        : (genre: string) => !SUPER_CATEGORIES.some(candidate => candidate.prefixes.includes(genrePrefix(genre)));
      toggleGenreGroup(genres().filter(inBucket));
      return;
    }
    if (value === 'video') {
      const features = videoFeatures();
      const next = new Set(graphicsFilter());
      const allSelected = features.length > 0 && features.every(feature => next.has(feature));
      for (const feature of features) {
        if (allSelected) next.delete(feature);
        else next.add(feature);
      }
      setGraphicsFilter(next);
      return;
    }
    if (value === 'memory') {
      const next = new Set(memoryFilter());
      const allSelected = [1, 16].every(ramKb => next.has(ramKb));
      for (const ramKb of [1, 16]) {
        if (allSelected) next.delete(ramKb);
        else next.add(ramKb);
      }
      setMemoryFilter(next);
      return;
    }
    if (value.startsWith('memory:')) {
      const ramKb = Number(value.slice('memory:'.length));
      const next = new Set(memoryFilter());
      if (next.has(ramKb)) next.delete(ramKb);
      else next.add(ramKb);
      setMemoryFilter(next);
      return;
    }
    if (value.startsWith('video:')) {
      const feature = value.slice('video:'.length);
      const next = new Set(graphicsFilter());
      if (next.has(feature)) next.delete(feature);
      else next.add(feature);
      setGraphicsFilter(next);
    }
  }

  async function play(game: Zx8xGame): Promise<void> {
    if (loadingGame()) return;
    const model = currentModel();
    if (game.model !== model) {
      setError(`This title is for ${game.model.toUpperCase()}, not ${model.toUpperCase()}.`);
      return;
    }
    setLoadingGame(game);
    setError('');
    try {
      const data = await fetchFirst(fileUrls(game.file));
      // Preserve ZXDB's RAM requirement: WRX1K software relies on the stock
      // 1KB mirrors, so blindly fitting 16KB changes the addresses it displays.
      // Hi-res hardware comes from ZXDB's ZX81 Enhanced Graphics tags, with
      // stable-ID fallbacks for catalogs published before those fields.
      const target = zx8xLaunchHardware(game, {
        ram16k: settings.zx8x16kRam(),
        udgRam: settings.zx81UdgRam(),
        udg128Ram: settings.zx81Udg128Ram(),
        wrxHires: settings.zx81WrxHires(),
        memotechHrg: settings.zx81MemotechHrg(),
        quickSilvaHrg: settings.zx81QuickSilvaHrg(),
      });
      const needsRebuild = settings.zx8x16kRam() !== target.ram16k
        || settings.zx81UdgRam() !== target.udgRam
        || settings.zx81Udg128Ram() !== target.udg128Ram
        || settings.zx81WrxHires() !== target.wrxHires
        || settings.zx81MemotechHrg() !== target.memotechHrg
        || settings.zx81QuickSilvaHrg() !== target.quickSilvaHrg;
      if (settings.zx8x16kRam() !== target.ram16k) {
        settings.setZx8x16kRam(target.ram16k);
        settings.persistSetting('zx8x-16k-ram', target.ram16k ? 'on' : 'off');
      }
      const modes = [
        [settings.zx81UdgRam, settings.setZx81UdgRam, 'zx81-udg-ram', target.udgRam],
        [settings.zx81Udg128Ram, settings.setZx81Udg128Ram, 'zx81-udg128-ram', target.udg128Ram],
        [settings.zx81WrxHires, settings.setZx81WrxHires, 'zx81-wrx-hires', target.wrxHires],
        [settings.zx81MemotechHrg, settings.setZx81MemotechHrg, 'zx81-memotech-hrg', target.memotechHrg],
        [settings.zx81QuickSilvaHrg, settings.setZx81QuickSilvaHrg, 'zx81-quicksilva-hrg', target.quickSilvaHrg],
      ] as const;
      for (const [get, set, key, value] of modes) {
        if (get() === value) continue;
        set(value);
        settings.persistSetting(key, value ? 'on' : 'off');
      }
      if (needsRebuild) await switchModel(model);
      await loadFile(data, basename(game.file));
    } catch {
      setError(`Could not download "${game.title}".`);
    } finally { setLoadingGame(null); }
  }

  return (
    <div class="library-browser">
      <div class="library-search">
        <div class="library-search-field">
          <input class="library-search-input" type="search" placeholder={`Search ${currentModel().toUpperCase()} software…`} value={query()} onInput={event => setQuery(event.currentTarget.value)} />
          <Show when={query()}><button class="library-search-clear" onClick={() => setQuery('')} aria-label="Clear search">×</button></Show>
        </div>
        <Show when={catalog()}>
          <div class="library-search-menu" classList={{ active: graphicsFilter().size > 0 || memoryFilter().size > 0 || genreFilter().size > 0 }}>
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
              <div class={`library-row${selected() === game ? ' selected' : ''}${loadingGame() === game ? ' loading' : ''}`} onClick={() => setSelected(selected() === game ? null : game)}>
                <span class="library-title">{game.title}</span>
                <a class="library-info" href={`https://spectrumcomputing.co.uk/entry/${game.id}/`} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()}><span class="library-info-i">i</span></a>
                <span class="library-play" onClick={event => { event.stopPropagation(); void play(game); }}>
                  <Show when={loadingGame() === game} fallback={<HiOutlinePlay />}><span class="library-spinner" /></Show>
                </span>
              </div>
              <Show when={selected() === game}><Detail game={game} /></Show>
            </div>}
          </For>
        </div>
      </Show>
    </div>
  );
}
