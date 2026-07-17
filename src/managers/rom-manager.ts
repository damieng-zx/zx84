/**
 * ROM Manager - handles ROM loading, caching, and persistence.
 *
 * Responsibilities:
 * - Cache ROM images per model (48K, 128K, +2, +2A, +3)
 * - Persist ROMs to IndexedDB for offline use
 * - Fetch default ROMs from CDN when needed
 * - Manage ROM labels and metadata
 */

import type { MachineModel } from '@/models.ts';
import { dbSave, dbLoad, dbDelete } from '@/store/persistence.ts';
import { BANK_SIZE } from '@/utils/bank-size.ts';

export interface ROMEntry {
  data: Uint8Array;
  label: string;
  /** True for a user-supplied ROM (upload); false for the stock default. Drives
   *  the ROM pane's eject-button visibility — the label text itself no longer
   *  carries a "(custom)" marker. */
  isCustom: boolean;
}

/** A 16K ROM page index within a multi-page model (see romPageSlotCount). */
export type RomPage = 0 | 1 | 2 | 3;

const ROM_BASE = 'https://zx84files.bitsparse.com/roms/';

/** Label for a freshly-fetched default ROM — model-specific naming where the
 *  underlying chip has a real name (Sinclair BASIC on the 16K/48K), falling
 *  back to a generic "<MODEL> (default)" otherwise. Always computed fresh
 *  (never persisted verbatim — see restoreROM) so a naming change here takes
 *  effect immediately, without a stale string surviving in localStorage. */
function defaultRomLabel(model: MachineModel): string {
  return (model === '16k' || model === '48k') ? 'Sinclair BASIC' : `${model.toUpperCase()} (default)`;
}

/** +2A/+3 default page names, in page-index order (0-3) — see
 *  romPageSlotCount and the 1FFD/7FFD ROM-select bit table in memory.ts. */
const PLUS3_PAGE_NAMES = ['128K Editor', '128K Syntax Checker', '+3DOS', '48K BASIC'];

/** Label for a default (non-overridden) 16K page of a multi-page model
 *  (128K/+2/+2A/+3 — see romPageSlotCount).
 *  - 128K/+2: page 0 the 128K editor/menu ROM, page 1 the 48K-compatible
 *    BASIC ROM. Named by author: Sinclair wrote the 128K's ROM set; the grey
 *    +2 shipped under Amstrad ownership with its own (different) ROM despite
 *    the shared 128K architecture.
 *  - +2A/+3: the four real ROM names (editor, syntax checker, +3DOS, 48K
 *    BASIC) — same for both, since the +2A reuses the +3's ROM set. */
export function defaultRomPageLabel(model: MachineModel, page: RomPage): string {
  if (model === '+2A' || model === '+3') return PLUS3_PAGE_NAMES[page];
  const maker = model === '+2' ? 'Amstrad' : 'Sinclair';
  return page === 0 ? `${maker} 128K BASIC` : `${maker} 48K BASIC`;
}

// Each model lists its ROM pages in order; they are fetched and concatenated.
// CPC models concatenate to OS(16KB) + BASIC(16KB) [+ AMSDOS(16KB)], the layout
// CpcMemory.loadROM() splits on.
const DEFAULT_ROM_URLS: Record<MachineModel, string[]> = {
  '16k':  [`${ROM_BASE}48.rom`],
  '48k':  [`${ROM_BASE}48.rom`],
  '128k': [`${ROM_BASE}128-0.rom`, `${ROM_BASE}128-1.rom`],
  '+2':   [`${ROM_BASE}plus2-0.rom`, `${ROM_BASE}plus2-1.rom`],
  '+2A':  [`${ROM_BASE}plus3-41-0.rom`, `${ROM_BASE}plus3-41-1.rom`, `${ROM_BASE}plus3-41-2.rom`, `${ROM_BASE}plus3-41-3.rom`],
  '+3':   [`${ROM_BASE}plus3-0.rom`, `${ROM_BASE}plus3-1.rom`, `${ROM_BASE}plus3-2.rom`, `${ROM_BASE}plus3-3.rom`],
  'cpc6128': [`${ROM_BASE}os6128.rom`, `${ROM_BASE}basic1-1.rom`, `${ROM_BASE}amsdos.rom`],
  'cpc464':  [`${ROM_BASE}os464.rom`, `${ROM_BASE}basic1-0.rom`],
  'cpc664':  [`${ROM_BASE}os664.rom`, `${ROM_BASE}basic664.rom`, `${ROM_BASE}amsdos.rom`],
  'einstein': [`${ROM_BASE}einstein-mos.rom`],
  'hx-10': [`${ROM_BASE}hx-10_basic-bios1.rom`],
};

export class ROMManager {
  private cache: Record<string, ROMEntry> = {};
  /** In-flight loadROM promises, deduplicated per model. */
  private inFlight: Partial<Record<MachineModel, Promise<ROMEntry | null>>> = {};

  /**
   * Persist a ROM image to cache and IndexedDB.
   * Cache is only populated if the IDB write succeeds, so cache and disk
   * never disagree on a failed save.
   */
  async persistROM(model: MachineModel, data: Uint8Array, label: string): Promise<void> {
    await dbSave(`rom-${model}`, data);
    this.cache[model] = { data, label, isCustom: true };
    try {
      localStorage.setItem(`zx84-rom-label-${model}`, label);
    } catch { /* private mode / quota — label will fall back on next restore */ }
  }

  /**
   * Restore a ROM from cache or IndexedDB.
   * Returns null if no ROM is stored OR if IDB throws (caller can fall back
   * to fetching the default).
   */
  async restoreROM(model: MachineModel): Promise<ROMEntry | null> {
    if (this.cache[model]) return this.cache[model];

    let data: Uint8Array | null;
    try {
      data = await dbLoad(`rom-${model}`);
    } catch {
      // Corrupt DB / quota / etc. — treat as "not stored" so loadROM can fall
      // back to the default fetch path rather than permanently bricking.
      return null;
    }
    if (!data) return null;

    // A stored label is only trusted when it's a real user-chosen custom name
    // (see setSystemRom). Anything shaped like a computed default label —
    // including stale text from an older naming scheme, e.g. "16K (default)"
    // — is discarded and recomputed fresh via defaultRomLabel().
    const stored = localStorage.getItem(`zx84-rom-label-${model}`);
    const isCustom = !!stored && !/\(default\)$/i.test(stored);
    this.cache[model] = isCustom
      ? { data, label: stored!, isCustom: true }
      : { data, label: defaultRomLabel(model), isCustom: false };
    return this.cache[model];
  }

  /**
   * Fetch default ROM from CDN and cache it.
   * Returns null if fetch fails.
   */
  async fetchDefaultROM(
    model: MachineModel,
    onStatus?: (msg: string) => void
  ): Promise<ROMEntry | null> {
    const urls = DEFAULT_ROM_URLS[model];
    onStatus?.(`Downloading ${model.toUpperCase()} ROM…`);

    try {
      const pages = await Promise.all(urls.map(async url => {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url.split('/').pop()}`);
        return new Uint8Array(await resp.arrayBuffer());
      }));

      // Concatenate pages into a single ROM image
      const totalLength = pages.reduce((n, p) => n + p.length, 0);
      const data = new Uint8Array(totalLength);
      let offset = 0;
      for (const page of pages) { data.set(page, offset); offset += page.length; }

      // Save the raw bytes for offline reuse, but do NOT persist a label to
      // localStorage — a default label is derived, not a real ROM name, and
      // must stay free to be recomputed if the naming logic changes later.
      await dbSave(`rom-${model}`, data);
      const label = defaultRomLabel(model);
      this.cache[model] = { data, label, isCustom: false };
      onStatus?.(`${model.toUpperCase()} ROM loaded`);

      return this.cache[model];
    } catch (err) {
      onStatus?.(`Failed to download ROM: ${(err as Error).message}`);
      return null;
    }
  }

  /** In-memory cache of the Einstein Xtal DOS boot disk. */
  private einsteinXtalDosDisk: Uint8Array | null = null;

  /**
   * Fetch the Einstein Xtal DOS boot disk (einstein-xtaldos.dsk) from the ROM
   * host, trying the in-memory then IndexedDB cache first. Returns null if it
   * can't be obtained (the Xtal DOS option then simply has no effect). Used to
   * boot Xtal DOS when the "Xtal DOS" hardware option is on and drive 0 is empty.
   */
  async fetchEinsteinXtalDosDisk(): Promise<Uint8Array | null> {
    if (this.einsteinXtalDosDisk) return this.einsteinXtalDosDisk;
    try {
      const cached = await dbLoad('disk-einstein-xtaldos');
      if (cached) { this.einsteinXtalDosDisk = cached; return cached; }
    } catch { /* fall through to network */ }
    try {
      const resp = await fetch(`${ROM_BASE}einstein-xtaldos.dsk`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = new Uint8Array(await resp.arrayBuffer());
      this.einsteinXtalDosDisk = data;
      try { await dbSave('disk-einstein-xtaldos', data); } catch { /* non-fatal */ }
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Load a ROM and return it, trying cache first, then fetching if needed.
   * Concurrent calls for the same model share a single in-flight promise.
   */
  loadROM(
    model: MachineModel,
    onStatus?: (msg: string) => void
  ): Promise<ROMEntry | null> {
    const existing = this.inFlight[model];
    if (existing) return existing;

    const p = (async () => {
      let entry = await this.restoreROM(model);
      if (!entry) entry = await this.fetchDefaultROM(model, onStatus);
      return entry;
    })().finally(() => { delete this.inFlight[model]; });

    this.inFlight[model] = p;
    return p;
  }

  /**
   * Get cached ROM without triggering a fetch.
   */
  getCached(model: MachineModel): ROMEntry | null {
    return this.cache[model] || null;
  }

  /**
   * Forget a model's stored ROM (in-memory cache, IndexedDB image, and label),
   * so the next load falls back to the CDN default. Used by "reset to default".
   */
  async clearROM(model: MachineModel): Promise<void> {
    delete this.cache[model];
    try { localStorage.removeItem(`zx84-rom-label-${model}`); } catch { /* */ }
    try { await dbDelete(`rom-${model}`); } catch { /* non-fatal */ }
  }

  // ── Per-page overrides (128K/+2/+2A/+3 multi-page models) ────────────────
  //
  // The ROM pane exposes multi-page models as independently loadable/
  // ejectable page slots instead of one combined image (2 pages for 128K/+2,
  // 4 for +2A/+3 — see romPageSlotCount). An override here sits on top of the
  // whole-model default fetched above; the caller (emulator.ts) splices
  // whichever pages are overridden into the base image before handing it to
  // the machine.

  private pageCache: Record<string, ROMEntry> = {};

  async persistROMPage(model: MachineModel, page: RomPage, data: Uint8Array, label: string): Promise<void> {
    const bytes = data.subarray(0, BANK_SIZE);
    await dbSave(`rom-${model}-page${page}`, bytes);
    this.pageCache[`${model}:${page}`] = { data: bytes, label, isCustom: true };
    try {
      localStorage.setItem(`zx84-rom-label-${model}-page${page}`, label);
    } catch { /* private mode / quota — label will fall back on next restore */ }
  }

  async restoreROMPage(model: MachineModel, page: RomPage): Promise<ROMEntry | null> {
    const cacheKey = `${model}:${page}`;
    if (this.pageCache[cacheKey]) return this.pageCache[cacheKey];

    let data: Uint8Array | null;
    try {
      data = await dbLoad(`rom-${model}-page${page}`);
    } catch {
      return null;
    }
    if (!data) return null;

    // A page cache entry only ever exists via persistROMPage (a custom
    // upload) — there's no "default page override" concept, so any entry
    // found here is by construction a custom one.
    const label = localStorage.getItem(`zx84-rom-label-${model}-page${page}`) || 'custom';
    this.pageCache[cacheKey] = { data, label, isCustom: true };
    return this.pageCache[cacheKey];
  }

  /** Get a cached page override without triggering a fetch. */
  getCachedPage(model: MachineModel, page: RomPage): ROMEntry | null {
    return this.pageCache[`${model}:${page}`] || null;
  }

  /** Forget a page override so it reverts to the model's default image. */
  async clearROMPage(model: MachineModel, page: RomPage): Promise<void> {
    delete this.pageCache[`${model}:${page}`];
    try { localStorage.removeItem(`zx84-rom-label-${model}-page${page}`); } catch { /* */ }
    try { await dbDelete(`rom-${model}-page${page}`); } catch { /* non-fatal */ }
  }
}
