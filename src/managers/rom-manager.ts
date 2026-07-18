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
import { entryForModel } from '@/machines/registry.ts';

export const ROM_BASE = 'https://zx84files.bitsparse.com/roms/';

/** Resolve a bare ROM filename against the default host without changing an
 * explicit URL or a path supplied by a machine definition. */
export function resolveRomSource(source: string): string {
  return source.includes('/') ? source : `${ROM_BASE}${source}`;
}

export interface ROMEntry {
  data: Uint8Array;
  label: string;
  /** True for a user-supplied ROM (upload); false for the stock default. Drives
   *  the ROM pane's eject-button visibility — the label text itself no longer
   *  carries a "(custom)" marker. */
  isCustom: boolean;
}

/** Page index + default page labels live with the Spectrum's model helpers
 *  (they describe Spectrum ROM sets); re-exported here for existing callers. */
export { defaultRomPageLabel, type RomPage } from '@/models.ts';
import type { RomPage } from '@/models.ts';

/** Label for a freshly-fetched default ROM — model-specific naming where the
 *  underlying chip has a real name (Sinclair BASIC on the 16K/48K), falling
 *  back to a generic "<MODEL> (default)" otherwise. Always computed fresh
 *  (never persisted verbatim — see restoreROM) so a naming change here takes
 *  effect immediately, without a stale string surviving in localStorage. */
function defaultRomLabel(model: MachineModel): string {
  return (model === '16k' || model === '48k') ? 'Sinclair BASIC' : `${model.toUpperCase()} (default)`;
}

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
    // Each machine's registry entry lists its ROM pages in order; they are
    // fetched and concatenated here (CPC: OS + BASIC [+ AMSDOS], the layout
    // CpcMemory.loadROM() splits on).
    const urls = entryForModel(model).romSources(model);
    onStatus?.(`Downloading ${model.toUpperCase()} ROM…`);

    try {
      const pages = await Promise.all(urls.map(async source => {
        const url = resolveRomSource(source);
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
      const resp = await fetch(resolveRomSource('einstein-xtaldos.dsk'));
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
