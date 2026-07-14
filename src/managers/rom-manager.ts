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
import { dbSave, dbLoad } from '@/store/persistence.ts';

export interface ROMEntry {
  data: Uint8Array;
  label: string;
}

const ROM_BASE = 'https://zx84files.bitsparse.com/roms/';

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
    this.cache[model] = { data, label };
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

    const label = localStorage.getItem(`zx84-rom-label-${model}`) || 'saved ROM';
    this.cache[model] = { data, label };
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

      const label = `${model.toUpperCase()} (default)`;
      await this.persistROM(model, data, label);
      onStatus?.(`${model.toUpperCase()} ROM loaded`);

      return { data, label };
    } catch (err) {
      onStatus?.(`Failed to download ROM: ${(err as Error).message}`);
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
}
