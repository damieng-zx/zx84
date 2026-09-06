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
import type { MachineLocale } from '@/machines/machine.ts';
import { dbSave, dbLoad, dbDelete } from '@/store/persistence.ts';
import { BANK_SIZE } from '@/utils/bank-size.ts';
import { entryForModel } from '@/machines/registry.ts';
import { unzip } from '@/media/zip.ts';

export const ROM_BASE = 'https://zx84files.bitsparse.com/roms/';

/** Resolve a ROM source against the default host. Bare filenames and relative
 *  paths (containing / but not ://) are prefixed with ROM_BASE; fully-qualified
 *  URLs are returned unchanged. */
export function resolveRomSource(source: string): string {
  if (source.includes('://')) return source;
  return `${ROM_BASE}${source}`;
}

/** ZIP local-file-header signature ("PK", 0x03, 0x04). */
function isZipArchive(d: Uint8Array): boolean {
  return d.length > 4 && d[0] === 0x50 && d[1] === 0x4B && d[2] === 0x03 && d[3] === 0x04;
}

/**
 * Unwrap a ROM source that is hosted as a ZIP archive.
 *
 * Some ROM images are only distributed zipped (the SAM Coupe's is), and
 * re-hosting an unpacked copy purely to satisfy the fetcher is busywork. Raw
 * images stay the common case and pass through untouched — the archive path is
 * entered only when the fetched bytes actually carry the ZIP signature, so no
 * existing ROM source changes behaviour.
 *
 * `unzip` already filters to loadable extensions, so a README or licence file
 * packed alongside the image is ignored. An archive holding more than one ROM
 * is ambiguous, and is rejected rather than guessed at.
 */
export async function unwrapRomArchive(data: Uint8Array, name: string): Promise<Uint8Array> {
  if (!isZipArchive(data)) return data;
  const entries = await unzip(data);
  if (entries.length === 0) throw new Error(`${name} contains no ROM image`);
  if (entries.length > 1) {
    throw new Error(`${name} contains ${entries.length} ROMs; expected exactly one`);
  }
  return entries[0].data;
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
function defaultRomLabel(key: string): string {
  // Strip locale suffix to get the base model for display
  const model = key.split('-')[0].toLowerCase();
  if (model === '16k' || model === '48k') return 'Sinclair BASIC';
  if (model === 'hx-10') return 'Toshiba HX-10 (MSX BASIC 1.0)';
  if (model === 'zx80') return 'Sinclair ZX80 BASIC';
  if (model === 'zx81') return 'Sinclair ZX81 BASIC';
  // Both SAM models run the same 32K EPROM, so the label names the ROM rather
  // than the machine — "SAM512" told you which model you had picked, not which
  // firmware was in it.
  if (model === 'sam256' || model === 'sam512') return 'SAM 3.0 PLC';
  return `${key.toUpperCase()} (default)`;
}

export class ROMManager {
  private cache: Record<string, ROMEntry> = {};
  /** In-flight loadROM promises, deduplicated per key. */
  private inFlight: Partial<Record<string, Promise<ROMEntry | null>>> = {};

  /**
   * Persist a ROM image to cache and IndexedDB.
   * Cache is only populated if the IDB write succeeds, so cache and disk
   * never disagree on a failed save.
   */
  async persistROM(key: string, data: Uint8Array, label: string): Promise<void> {
    await dbSave(`rom-${key}`, data);
    this.cache[key] = { data, label, isCustom: true };
    try {
      localStorage.setItem(`zx84-rom-label-${key}`, label);
    } catch { /* private mode / quota — label will fall back on next restore */ }
  }

  /**
   * Restore a ROM from cache or IndexedDB.
   * Returns null if no ROM is stored OR if IDB throws (caller can fall back
   * to fetching the default).
   */
  async restoreROM(key: string): Promise<ROMEntry | null> {
    if (this.cache[key]) return this.cache[key];

    let data: Uint8Array | null;
    try {
      data = await dbLoad(`rom-${key}`);
    } catch {
      // Corrupt DB / quota / etc. — treat as "not stored" so loadROM can fall
      // back to the default fetch path rather than permanently bricking.
      return null;
    }
    if (!data) return null;

    // A zipped image may have been cached before `fetchDefaultROM` learned to
    // unwrap them, and a stale cache entry would otherwise brick that machine
    // for good — the fetch path it needs is never reached, because there IS a
    // stored ROM. Raw images are untouched: only PK-signed bytes take this
    // branch.
    try {
      data = await unwrapRomArchive(data, key);
    } catch {
      return null;   // unusable archive: fall back to a fresh download
    }

    // A stored label is only trusted when it's a real user-chosen custom name
    // (see setSystemRom). Anything shaped like a computed default label —
    // including stale text from an older naming scheme, e.g. "16K (default)"
    // — is discarded and recomputed fresh via defaultRomLabel().
    const stored = localStorage.getItem(`zx84-rom-label-${key}`);
    const isCustom = !!stored && !/\(default\)$/i.test(stored);
    this.cache[key] = isCustom
      ? { data, label: stored!, isCustom: true }
      : { data, label: defaultRomLabel(key), isCustom: false };
    return this.cache[key];
  }

  /**
   * Fetch default ROM from CDN and cache it. `model` is the base MachineModel
   * (for ROM source lookup), `key` is the cache key (may include locale),
   * `locale` selects the locale-specific ROM source variant.
   * Returns null if fetch fails.
   */
  async fetchDefaultROM(
    model: MachineModel,
    key: string,
    locale?: MachineLocale,
    onStatus?: (msg: string) => void
  ): Promise<ROMEntry | null> {
    // Each machine's registry entry lists its ROM pages in order; they are
    // fetched and concatenated here (CPC: OS + BASIC [+ AMSDOS], the layout
    // CpcMemory.loadROM() splits on).
    const urls = entryForModel(model).romSources(model, locale);
    onStatus?.(`Downloading ${key.toUpperCase()} ROM…`);

    try {
      const pages = await Promise.all(urls.map(async source => {
        const url = resolveRomSource(source);
        const name = url.split('/').pop() ?? source;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${name}`);
        return unwrapRomArchive(new Uint8Array(await resp.arrayBuffer()), name);
      }));

      // Concatenate pages into a single ROM image
      const totalLength = pages.reduce((n, p) => n + p.length, 0);
      const data = new Uint8Array(totalLength);
      let offset = 0;
      for (const page of pages) { data.set(page, offset); offset += page.length; }

      // Save the raw bytes for offline reuse, but do NOT persist a label to
      // localStorage — a default label is derived, not a real ROM name, and
      // must stay free to be recomputed if the naming logic changes later.
      await dbSave(`rom-${key}`, data);
      const label = defaultRomLabel(key);
      this.cache[key] = { data, label, isCustom: false };
      onStatus?.(`${key.toUpperCase()} ROM loaded`);

      return this.cache[key];
    } catch (err) {
      onStatus?.(`Failed to download ROM: ${(err as Error).message}`);
      return null;
    }
  }

  /** In-memory cache of hidden default boot disks, keyed by machine-owned key. */
  private bootDisks = new Map<string, Uint8Array>();

  /**
   * Fetch a machine-declared hidden boot disk, trying memory and IndexedDB
   * before the public source. Returns null when unavailable, leaving the
   * hardware profile enabled but with an empty drive.
   */
  async fetchBootDisk(source: string, cacheKey: string): Promise<Uint8Array | null> {
    const memory = this.bootDisks.get(cacheKey);
    if (memory) return memory;
    try {
      const cached = await dbLoad(cacheKey);
      if (cached) { this.bootDisks.set(cacheKey, cached); return cached; }
    } catch { /* fall through to network */ }
    try {
      const resp = await fetch(resolveRomSource(source));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = new Uint8Array(await resp.arrayBuffer());
      this.bootDisks.set(cacheKey, data);
      try { await dbSave(cacheKey, data); } catch { /* non-fatal */ }
      return data;
    } catch {
      return null;
    }
  }

  /** In-memory cache of hidden default boot cartridges, keyed by source. */
  private bootCartridges = new Map<string, Uint8Array>();

  /**
   * Fetch a machine's hidden default boot cartridge from `source` (a ROM-host
   * name or fully-qualified URL, resolved via resolveRomSource), trying the
   * in-memory then IndexedDB cache first. Machine-agnostic: the source string
   * is supplied by the machine entry's `bootCartridgeSource` hook, so no
   * per-machine specifics leak into this layer. Returns null if unobtainable.
   */
  async fetchBootCartridge(source: string): Promise<Uint8Array | null> {
    const mem = this.bootCartridges.get(source);
    if (mem) return mem;
    const key = `boot-cart-${source.split('/').pop()}`;
    try {
      const cached = await dbLoad(key);
      if (cached) { this.bootCartridges.set(source, cached); return cached; }
    } catch { /* fall through to network */ }
    try {
      const resp = await fetch(resolveRomSource(source));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = new Uint8Array(await resp.arrayBuffer());
      this.bootCartridges.set(source, data);
      try { await dbSave(key, data); } catch { /* non-fatal */ }
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Load a ROM and return it, trying cache first, then fetching if needed.
   * Concurrent calls for the same key share a single in-flight promise.
   * `model` is the base MachineModel for source lookup; `key` is the cache key.
   */
  loadROM(
    model: MachineModel,
    key: string,
    locale?: MachineLocale,
    onStatus?: (msg: string) => void
  ): Promise<ROMEntry | null> {
    const existing = this.inFlight[key];
    if (existing) return existing;

    const p = (async () => {
      let entry = await this.restoreROM(key);
      if (!entry) entry = await this.fetchDefaultROM(model, key, locale, onStatus);
      return entry;
    })().finally(() => { delete this.inFlight[key]; });

    this.inFlight[key] = p;
    return p;
  }

  /**
   * Get cached ROM without triggering a fetch.
   */
  getCached(key: string): ROMEntry | null {
    return this.cache[key] || null;
  }

  /**
   * Forget a ROM's stored data (in-memory cache, IndexedDB image, and label),
   * so the next load falls back to the CDN default. Used by "reset to default".
   */
  async clearROM(key: string): Promise<void> {
    delete this.cache[key];
    try { localStorage.removeItem(`zx84-rom-label-${key}`); } catch { /* */ }
    try { await dbDelete(`rom-${key}`); } catch { /* non-fatal */ }
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

  async persistROMPage(key: string, page: RomPage, data: Uint8Array, label: string): Promise<void> {
    const bytes = data.subarray(0, BANK_SIZE);
    await dbSave(`rom-${key}-page${page}`, bytes);
    this.pageCache[`${key}:${page}`] = { data: bytes, label, isCustom: true };
    try {
      localStorage.setItem(`zx84-rom-label-${key}-page${page}`, label);
    } catch { /* private mode / quota — label will fall back on next restore */ }
  }

  async restoreROMPage(key: string, page: RomPage): Promise<ROMEntry | null> {
    const cacheKey = `${key}:${page}`;
    if (this.pageCache[cacheKey]) return this.pageCache[cacheKey];

    let data: Uint8Array | null;
    try {
      data = await dbLoad(`rom-${key}-page${page}`);
    } catch {
      return null;
    }
    if (!data) return null;

    // A page cache entry only ever exists via persistROMPage (a custom
    // upload) — there's no "default page override" concept, so any entry
    // found here is by construction a custom one.
    const label = localStorage.getItem(`zx84-rom-label-${key}-page${page}`) || 'custom';
    this.pageCache[cacheKey] = { data, label, isCustom: true };
    return this.pageCache[cacheKey];
  }

  /** Get a cached page override without triggering a fetch. */
  getCachedPage(key: string, page: RomPage): ROMEntry | null {
    return this.pageCache[`${key}:${page}`] || null;
  }

  /** Forget a page override so it reverts to the model's default image. */
  async clearROMPage(key: string, page: RomPage): Promise<void> {
    delete this.pageCache[`${key}:${page}`];
    try { localStorage.removeItem(`zx84-rom-label-${key}-page${page}`); } catch { /* */ }
    try { await dbDelete(`rom-${key}-page${page}`); } catch { /* non-fatal */ }
  }
}
