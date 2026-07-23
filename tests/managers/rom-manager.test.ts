/**
 * Tests for ROMManager.
 *
 * Lock-ins for previously-fragile behaviour:
 *  - Default ROM label is the model name, not the first page's filename
 *    (multi-page ROMs aren't misrepresented as one of their halves).
 *  - restoreROM() swallows IDB errors so loadROM() can fall back to
 *    fetching the default instead of permanently bricking.
 *  - persistROM() only populates the cache after the IDB write succeeds;
 *    a failed save leaves cache and disk consistent.
 *  - loadROM() deduplicates concurrent calls for the same model via an
 *    in-flight promise map (one fetch, not N).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock persistence layer (in-memory IDB, no real indexedDB needed) ──────

const idb = new Map<string, Uint8Array>();
const dbSave = vi.fn(async (key: string, data: Uint8Array) => {
  idb.set(key, data);
});
const dbLoad = vi.fn(async (key: string) => idb.get(key) ?? null);
const dbDelete = vi.fn(async (key: string) => {
  idb.delete(key);
});

vi.mock('@/store/persistence.ts', () => ({
  dbSave: (key: string, data: Uint8Array) => dbSave(key, data),
  dbLoad: (key: string) => dbLoad(key),
  dbDelete: (key: string) => dbDelete(key),
}));

// ── localStorage shim (node environment has no DOM) ───────────────────────

class FakeLocalStorage {
  private store = new Map<string, string>();
  /** When true, every setItem throws (simulates private-mode / quota). */
  throwOnSet = false;
  getItem(k: string) { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string) {
    if (this.throwOnSet) throw new DOMException('quota', 'QuotaExceededError');
    this.store.set(k, v);
  }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

let fakeLS: FakeLocalStorage;
beforeEach(() => {
  idb.clear();
  dbSave.mockClear();
  dbLoad.mockClear();
  dbDelete.mockClear();
  fakeLS = new FakeLocalStorage();
  (globalThis as any).localStorage = fakeLS;
});

// ── Fetch fake ────────────────────────────────────────────────────────────

interface FetchSpec {
  status?: number;
  body?: Uint8Array;
  fail?: boolean;        // network error
  delayMs?: number;      // staggering for concurrent tests
}
function installFetch(routes: Record<string, FetchSpec | FetchSpec[]>): { calls: string[] } {
  const calls: string[] = [];
  const nextIdx: Record<string, number> = {};
  (globalThis as any).fetch = async (url: string) => {
    calls.push(url);
    let spec: FetchSpec | undefined;
    const r = routes[url];
    if (Array.isArray(r)) {
      const i = nextIdx[url] ?? 0;
      spec = r[i];
      nextIdx[url] = i + 1;
    } else {
      spec = r;
    }
    if (!spec) throw new Error(`Unexpected fetch: ${url}`);
    if (spec.delayMs) await new Promise(r => setTimeout(r, spec!.delayMs));
    if (spec.fail) throw new Error('network down');
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => spec!.body?.buffer ?? new ArrayBuffer(0),
    } as Response;
  };
  return { calls };
}

// ── Import under test (after mocks are in place) ──────────────────────────

import { ROM_BASE, ROMManager, defaultRomPageLabel, resolveRomSource } from '@/managers/rom-manager.ts';

describe('resolveRomSource', () => {
  it('prepends the ROM host for a bare filename', () => {
    expect(resolveRomSource('48.rom')).toBe(`${ROM_BASE}48.rom`);
  });

  it('prepends the ROM host for a subfolder path', () => {
    expect(resolveRomSource('sinclair/48.rom')).toBe(`${ROM_BASE}sinclair/48.rom`);
  });

  it('preserves a fully-qualified URL', () => {
    expect(resolveRomSource('https://example.test/roms/custom.rom')).toBe('https://example.test/roms/custom.rom');
  });
});

// ── persistROM / restoreROM ───────────────────────────────────────────────

describe('ROMManager.persistROM / restoreROM', () => {
  it('round-trips a ROM through cache + IndexedDB', async () => {
    const m = new ROMManager();
    const rom = new Uint8Array([1, 2, 3, 4]);
    await m.persistROM('48k', rom, 'my-rom.rom');

    expect(m.getCached('48k')?.label).toBe('my-rom.rom');
    expect(Array.from(m.getCached('48k')!.data)).toEqual([1, 2, 3, 4]);
    expect(idb.get('rom-48k')).toBe(rom);
    expect(fakeLS.getItem('zx84-rom-label-48k')).toBe('my-rom.rom');
  });

  it('persistROM marks the entry as custom', async () => {
    const m = new ROMManager();
    await m.persistROM('48k', new Uint8Array([1]), 'my-rom.rom');
    expect(m.getCached('48k')?.isCustom).toBe(true);
  });

  it('restoreROM marks a genuinely custom stored label as custom', async () => {
    const a = new ROMManager();
    await a.persistROM('128k', new Uint8Array([1]), 'my128.rom');
    const b = new ROMManager();
    const got = await b.restoreROM('128k');
    expect(got?.isCustom).toBe(true);
    expect(got?.label).toBe('my128.rom');
  });

  it('restoreROM returns the cached entry without touching IDB', async () => {
    const m = new ROMManager();
    await m.persistROM('48k', new Uint8Array([0xAA]), 'cached');
    dbLoad.mockClear();
    const got = await m.restoreROM('48k');
    expect(got?.label).toBe('cached');
    expect(dbLoad).not.toHaveBeenCalled();
  });

  it('restoreROM loads from IDB and re-populates the cache on a cold start', async () => {
    // First instance writes; a second instance (simulating page reload) reads.
    const a = new ROMManager();
    await a.persistROM('128k', new Uint8Array([1, 2]), 'fresh-128.rom');

    const b = new ROMManager();
    const got = await b.restoreROM('128k');
    expect(got).not.toBeNull();
    expect(got!.label).toBe('fresh-128.rom');
    expect(Array.from(got!.data)).toEqual([1, 2]);
    // Subsequent calls now hit the cache.
    dbLoad.mockClear();
    await b.restoreROM('128k');
    expect(dbLoad).not.toHaveBeenCalled();
  });

  it('restoreROM returns null when no ROM is stored', async () => {
    const m = new ROMManager();
    expect(await m.restoreROM('+3')).toBeNull();
  });

  it('restoreROM recomputes the default label when none is stored', async () => {
    // Simulate: IDB has the ROM but localStorage label was lost (e.g. private
    // tab, separate domain). Pre-seed IDB without ever writing the label.
    idb.set('rom-128k', new Uint8Array([0xFF]));
    const m = new ROMManager();
    const got = await m.restoreROM('128k');
    expect(got?.label).toBe('128K (default)');
    expect(got?.isCustom).toBe(false);
  });

  it('restoreROM discards a stale default-shaped label and recomputes it fresh', async () => {
    // A label persisted by an older naming scheme (e.g. "16K (default)" before
    // 16K/48K were renamed to "Sinclair BASIC") must not survive — it's not a
    // real user-chosen name, so it's discarded rather than trusted verbatim.
    idb.set('rom-48k', new Uint8Array([0xFF]));
    fakeLS.setItem('zx84-rom-label-48k', '48K (default)');
    const m = new ROMManager();
    const got = await m.restoreROM('48k');
    expect(got?.label).toBe('Sinclair BASIC');
    expect(got?.isCustom).toBe(false);
  });

  it('restoreROM trusts a genuinely custom label', async () => {
    idb.set('rom-48k', new Uint8Array([0xFF]));
    fakeLS.setItem('zx84-rom-label-48k', 'my-hacked-rom.rom');
    const m = new ROMManager();
    const got = await m.restoreROM('48k');
    expect(got?.label).toBe('my-hacked-rom.rom');
    expect(got?.isCustom).toBe(true);
  });

  it('persistROM survives localStorage throwing (private-mode quota error)', async () => {
    fakeLS.throwOnSet = true;
    const m = new ROMManager();
    await expect(
      m.persistROM('48k', new Uint8Array([1]), 'x.rom'),
    ).resolves.toBeUndefined();
    // Cache + IDB both still populated.
    expect(m.getCached('48k')?.label).toBe('x.rom');
    expect(idb.get('rom-48k')).toBeDefined();
  });

  it('cache is not populated when the IDB write fails (no RAM/disk skew)', async () => {
    dbSave.mockImplementationOnce(async () => { throw new Error('IDB down'); });
    const m = new ROMManager();
    await expect(
      m.persistROM('48k', new Uint8Array([1]), 'x.rom'),
    ).rejects.toThrow('IDB down');
    expect(m.getCached('48k')).toBeNull();
    expect(idb.get('rom-48k')).toBeUndefined();
  });
});

// ── fetchDefaultROM ───────────────────────────────────────────────────────

describe('ROMManager.fetchDefaultROM', () => {
  it('downloads a single-page ROM and persists it', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    installFetch({ [`${ROM_BASE}sinclair/48.rom`]: { body } });

    const m = new ROMManager();
    const got = await m.fetchDefaultROM('48k', '48k');
    expect(got).not.toBeNull();
    expect(Array.from(got!.data)).toEqual([1, 2, 3, 4]);
    expect(got!.label).toBe('Sinclair BASIC');
    expect(got!.isCustom).toBe(false);
    expect(idb.get('rom-48k')).toEqual(body);
  });

  it('concatenates multi-page ROMs in URL order', async () => {
    installFetch({
      [`${ROM_BASE}sinclair/128-0.rom`]: { body: new Uint8Array([0xAA, 0xBB]) },
      [`${ROM_BASE}sinclair/128-1.rom`]: { body: new Uint8Array([0xCC, 0xDD, 0xEE]) },
    });
    const m = new ROMManager();
    const got = await m.fetchDefaultROM('128k', '128k');
    expect(got).not.toBeNull();
    expect(Array.from(got!.data)).toEqual([0xAA, 0xBB, 0xCC, 0xDD, 0xEE]);
  });

  it('concatenates 4-page +3 ROM in correct order even if pages return out-of-order', async () => {
    // page 1 takes longer than page 3 — concat order must follow URL order.
    installFetch({
      [`${ROM_BASE}sinclair/plus3-0.rom`]: { body: new Uint8Array([0]), delayMs: 5 },
      [`${ROM_BASE}sinclair/plus3-1.rom`]: { body: new Uint8Array([1]), delayMs: 30 },
      [`${ROM_BASE}sinclair/plus3-2.rom`]: { body: new Uint8Array([2]), delayMs: 0 },
      [`${ROM_BASE}sinclair/plus3-3.rom`]: { body: new Uint8Array([3]), delayMs: 15 },
    });
    const m = new ROMManager();
    const got = await m.fetchDefaultROM('+3', '+3');
    expect(Array.from(got!.data)).toEqual([0, 1, 2, 3]);
  });

  it('returns null and surfaces status if a single page returns HTTP error', async () => {
    installFetch({
      [`${ROM_BASE}sinclair/128-0.rom`]: { body: new Uint8Array([0xAA]) },
      [`${ROM_BASE}sinclair/128-1.rom`]: { status: 404 },
    });
    const status = vi.fn();
    const m = new ROMManager();
    const got = await m.fetchDefaultROM('128k', '128k', undefined, status);
    expect(got).toBeNull();
    // Nothing persisted on partial failure.
    expect(idb.get('rom-128k')).toBeUndefined();
    expect(m.getCached('128k')).toBeNull();
    // Failure message reported via callback.
    expect(status.mock.calls.map(c => c[0])).toEqual(
      expect.arrayContaining([expect.stringContaining('Failed to download')]),
    );
  });

  it('returns null on network failure', async () => {
    installFetch({ [`${ROM_BASE}sinclair/48.rom`]: { fail: true } });
    const status = vi.fn();
    const m = new ROMManager();
    expect(await m.fetchDefaultROM('48k', '48k', undefined, status)).toBeNull();
    expect(status.mock.calls.some(c => /Failed/.test(c[0] as string))).toBe(true);
  });

  it('calls onStatus before download and after success', async () => {
    installFetch({ [`${ROM_BASE}sinclair/48.rom`]: { body: new Uint8Array([1]) } });
    const status = vi.fn();
    const m = new ROMManager();
    await m.fetchDefaultROM('48k', '48k', undefined, status);
    const msgs = status.mock.calls.map(c => c[0] as string);
    expect(msgs[0]).toMatch(/Downloading/i);
    expect(msgs[msgs.length - 1]).toMatch(/loaded/i);
  });

  it('labels default ROMs by model, not by first-page filename', async () => {
    installFetch({
      [`${ROM_BASE}sinclair/128-0.rom`]: { body: new Uint8Array([1]) },
      [`${ROM_BASE}sinclair/128-1.rom`]: { body: new Uint8Array([2]) },
    });
    const m = new ROMManager();
    const got = await m.fetchDefaultROM('128k', '128k');
    expect(got!.label).toBe('128K (default)');
  });

  it('single-page default ROMs use the same model-named label', async () => {
    installFetch({ [`${ROM_BASE}sinclair/48.rom`]: { body: new Uint8Array([1]) } });
    const m = new ROMManager();
    const got = await m.fetchDefaultROM('48k', '48k');
    expect(got!.label).toBe('Sinclair BASIC');
  });

  it('16K default ROM also uses the Sinclair BASIC label', async () => {
    // The 16K shares the 48K's ROM image (same Sinclair BASIC content).
    installFetch({ [`${ROM_BASE}sinclair/48.rom`]: { body: new Uint8Array([1]) } });
    const m = new ROMManager();
    const got = await m.fetchDefaultROM('16k', '16k');
    expect(got!.label).toBe('Sinclair BASIC');
  });
});

// ── loadROM (cache → IDB → fetch) ─────────────────────────────────────────

describe('ROMManager.fetchBootDisk', () => {
  it('fetches a fully-qualified public disk once and persists it under the machine key', async () => {
    const source = 'https://example.test/mtx/system.mfloppy';
    const body = new Uint8Array([0x07, 0x80, 0x22]);
    const { calls } = installFetch({ [source]: { body } });
    const m = new ROMManager();

    const first = await m.fetchBootDisk(source, 'disk-mtx-cpm-test');
    const second = await m.fetchBootDisk(source, 'disk-mtx-cpm-test');

    expect(Array.from(first ?? [])).toEqual([0x07, 0x80, 0x22]);
    expect(second).toBe(first);
    expect(calls).toEqual([source]);
    expect(idb.get('disk-mtx-cpm-test')).toEqual(body);
  });

  it('restores a boot disk from IndexedDB without fetching', async () => {
    idb.set('disk-mtx-cpm-test', new Uint8Array([0xA5]));
    const { calls } = installFetch({});

    const got = await new ROMManager().fetchBootDisk(
      'https://example.test/mtx/system.mfloppy',
      'disk-mtx-cpm-test',
    );

    expect(Array.from(got ?? [])).toEqual([0xA5]);
    expect(calls).toEqual([]);
  });
});

describe('ROMManager.loadROM', () => {
  it('returns the in-memory cached entry without fetching', async () => {
    const { calls } = installFetch({});
    const m = new ROMManager();
    await m.persistROM('48k', new Uint8Array([9]), 'cached');
    const got = await m.loadROM('48k', '48k');
    expect(got?.label).toBe('cached');
    expect(calls).toEqual([]);
  });

  it('returns the IDB-stored entry without fetching', async () => {
    const { calls } = installFetch({});
    // Seed IDB only.
    idb.set('rom-+2', new Uint8Array([0xEE]));
    fakeLS.setItem('zx84-rom-label-+2', 'restored');
    const m = new ROMManager();
    const got = await m.loadROM('+2', '+2');
    expect(got?.label).toBe('restored');
    expect(calls).toEqual([]);
  });

  it('falls back to fetchDefaultROM when nothing is cached', async () => {
    const { calls } = installFetch({
      [`${ROM_BASE}sinclair/48.rom`]: { body: new Uint8Array([1, 2]) },
    });
    const m = new ROMManager();
    const got = await m.loadROM('48k', '48k');
    expect(got).not.toBeNull();
    expect(calls).toEqual([`${ROM_BASE}sinclair/48.rom`]);
  });

  it('returns null when neither cache nor fetch succeeds', async () => {
    installFetch({ [`${ROM_BASE}sinclair/48.rom`]: { status: 500 } });
    const m = new ROMManager();
    expect(await m.loadROM('48k', '48k')).toBeNull();
  });

  it('falls back to fetching when IndexedDB throws (corrupt-DB recovery)', async () => {
    dbLoad.mockImplementationOnce(async () => { throw new Error('IDB corrupt'); });
    const { calls } = installFetch({
      [`${ROM_BASE}sinclair/48.rom`]: { body: new Uint8Array([0xAB]) },
    });
    const m = new ROMManager();
    const got = await m.loadROM('48k', '48k');
    expect(got).not.toBeNull();
    expect(Array.from(got!.data)).toEqual([0xAB]);
    expect(calls).toEqual([`${ROM_BASE}sinclair/48.rom`]);
  });

  it('deduplicates concurrent calls for the same model into one fetch', async () => {
    const { calls } = installFetch({
      [`${ROM_BASE}sinclair/48.rom`]: { body: new Uint8Array([1]), delayMs: 20 },
    });
    const m = new ROMManager();
    const [a, b, c] = await Promise.all([
      m.loadROM('48k', '48k'),
      m.loadROM('48k', '48k'),
      m.loadROM('48k', '48k'),
    ]);
    // All three resolve to the same entry; only one network round-trip.
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(calls.length).toBe(1);
  });

  it('clears the in-flight entry after settle so retries work', async () => {
    // First call: 500 → null. Second call: 200 → success.
    installFetch({
      [`${ROM_BASE}sinclair/48.rom`]: [{ status: 500 }, { body: new Uint8Array([0x42]) }],
    });
    const m = new ROMManager();
    expect(await m.loadROM('48k', '48k')).toBeNull();
    const got = await m.loadROM('48k', '48k');
    expect(got).not.toBeNull();
    expect(Array.from(got!.data)).toEqual([0x42]);
  });

  it('does not dedupe across different models', async () => {
    const { calls } = installFetch({
      [`${ROM_BASE}sinclair/48.rom`]:    { body: new Uint8Array([1]), delayMs: 10 },
      [`${ROM_BASE}sinclair/plus2-0.rom`]: { body: new Uint8Array([2]), delayMs: 10 },
      [`${ROM_BASE}sinclair/plus2-1.rom`]: { body: new Uint8Array([3]), delayMs: 10 },
    });
    const m = new ROMManager();
    await Promise.all([m.loadROM('48k', '48k'), m.loadROM('+2', '+2')]);
    expect(calls.length).toBe(3); // 1 page for 48k + 2 pages for +2
  });
});

// ── getCached ─────────────────────────────────────────────────────────────

describe('ROMManager.getCached', () => {
  it('returns null when nothing is cached', () => {
    expect(new ROMManager().getCached('48k')).toBeNull();
  });

  it('returns the same object reference as the cached entry (no defensive copy)', async () => {
    const m = new ROMManager();
    const data = new Uint8Array([1, 2, 3]);
    await m.persistROM('48k', data, 'r');
    const got = m.getCached('48k')!;
    expect(got.data).toBe(data); // same reference
    // Caller mutating data would mutate the cache; documented, not asserted as "correct".
  });

  it('does not trigger any IDB or network access', async () => {
    const { calls } = installFetch({});
    dbLoad.mockClear();
    const m = new ROMManager();
    m.getCached('48k');
    expect(dbLoad).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

// ── Per-page overrides (128K/+2 dual-ROM models) ───────────────────────────

describe('ROMManager.persistROMPage / restoreROMPage / getCachedPage', () => {
  it('round-trips a page override through cache + IndexedDB, keyed independently per page', async () => {
    const m = new ROMManager();
    await m.persistROMPage('128k', 0, new Uint8Array([1, 2, 3]), 'editor.rom');
    await m.persistROMPage('128k', 1, new Uint8Array([4, 5, 6]), 'basic.rom');

    expect(m.getCachedPage('128k', 0)?.label).toBe('editor.rom');
    expect(m.getCachedPage('128k', 1)?.label).toBe('basic.rom');
    expect(Array.from(m.getCachedPage('128k', 0)!.data)).toEqual([1, 2, 3]);
    expect(Array.from(m.getCachedPage('128k', 1)!.data)).toEqual([4, 5, 6]);
    expect(idb.get('rom-128k-page0')).toEqual(new Uint8Array([1, 2, 3]));
    expect(idb.get('rom-128k-page1')).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('persistROMPage/restoreROMPage always mark the entry as custom (there is no "default override")', async () => {
    const m = new ROMManager();
    await m.persistROMPage('128k', 0, new Uint8Array([1]), 'editor.rom');
    expect(m.getCachedPage('128k', 0)?.isCustom).toBe(true);

    const b = new ROMManager();
    const got = await b.restoreROMPage('128k', 0);
    expect(got?.isCustom).toBe(true);
  });

  it('truncates an oversized page image to 16KB', async () => {
    const m = new ROMManager();
    const img = new Uint8Array(20000);
    img[16383] = 0x42;
    img[16384] = 0x99; // beyond 16K — must be dropped
    await m.persistROMPage('128k', 0, img, 'big.rom');
    const got = m.getCachedPage('128k', 0)!;
    expect(got.data.length).toBe(16384);
    expect(got.data[16383]).toBe(0x42);
  });

  it('getCachedPage returns null when nothing is overridden', () => {
    expect(new ROMManager().getCachedPage('128k', 0)).toBeNull();
  });

  it('restoreROMPage returns null (not a fetch fallback) when no override is stored', async () => {
    const m = new ROMManager();
    expect(await m.restoreROMPage('128k', 0)).toBeNull();
  });

  it('restoreROMPage returns the cached entry without touching IDB', async () => {
    const m = new ROMManager();
    await m.persistROMPage('128k', 1, new Uint8Array([9]), 'cached');
    dbLoad.mockClear();
    const got = await m.restoreROMPage('128k', 1);
    expect(got?.label).toBe('cached');
    expect(dbLoad).not.toHaveBeenCalled();
  });

  it('restoreROMPage loads from IDB and re-populates the cache on a cold start', async () => {
    const a = new ROMManager();
    await a.persistROMPage('128k', 0, new Uint8Array([7, 7]), 'persisted.rom');

    const b = new ROMManager(); // fresh instance — empty in-memory cache
    const got = await b.restoreROMPage('128k', 0);
    expect(got?.label).toBe('persisted.rom');
    expect(Array.from(got!.data)).toEqual([7, 7]);
  });

  it('pages for the same model are independent — clearing one leaves the other intact', async () => {
    const m = new ROMManager();
    await m.persistROMPage('128k', 0, new Uint8Array([1]), 'page0');
    await m.persistROMPage('128k', 1, new Uint8Array([2]), 'page1');
    await m.clearROMPage('128k', 0);

    expect(m.getCachedPage('128k', 0)).toBeNull();
    expect(m.getCachedPage('128k', 1)?.label).toBe('page1');
    expect(await m.restoreROMPage('128k', 0)).toBeNull();
    expect((await m.restoreROMPage('128k', 1))?.label).toBe('page1');
  });

  it('pages for different models never collide on the same key', async () => {
    const m = new ROMManager();
    await m.persistROMPage('128k', 0, new Uint8Array([1]), '128k-page0');
    await m.persistROMPage('+2', 0, new Uint8Array([2]), '+2-page0');

    expect(m.getCachedPage('128k', 0)?.label).toBe('128k-page0');
    expect(m.getCachedPage('+2', 0)?.label).toBe('+2-page0');
  });
});

describe('ROMManager.clearROMPage', () => {
  it('removes the cache entry, IDB image, and stored label', async () => {
    const m = new ROMManager();
    await m.persistROMPage('128k', 1, new Uint8Array([1]), 'x.rom');
    await m.clearROMPage('128k', 1);

    expect(m.getCachedPage('128k', 1)).toBeNull();
    expect(idb.get('rom-128k-page1')).toBeUndefined();
    expect(fakeLS.getItem('zx84-rom-label-128k-page1')).toBeNull();
  });

  it('is a no-op (does not throw) when nothing was ever persisted', async () => {
    const m = new ROMManager();
    await expect(m.clearROMPage('128k', 0)).resolves.not.toThrow();
  });
});

describe('defaultRomPageLabel', () => {
  it('names the 128K pages by their real ROM identity, not "(default)"', () => {
    expect(defaultRomPageLabel('128k', 0)).toBe('Sinclair 128K BASIC');
    expect(defaultRomPageLabel('128k', 1)).toBe('Sinclair 48K BASIC');
  });

  it('credits Amstrad (not Sinclair) for the +2\'s ROM — a different image despite the shared architecture', () => {
    expect(defaultRomPageLabel('+2', 0)).toBe('Amstrad 128K BASIC');
    expect(defaultRomPageLabel('+2', 1)).toBe('Amstrad 48K BASIC');
  });

  it('names all four +3 pages by their real ROM identity (1FFD/7FFD select order)', () => {
    expect(defaultRomPageLabel('+3', 0)).toBe('128K Editor');
    expect(defaultRomPageLabel('+3', 1)).toBe('128K Syntax Checker');
    expect(defaultRomPageLabel('+3', 2)).toBe('+3DOS');
    expect(defaultRomPageLabel('+3', 3)).toBe('48K BASIC');
  });

  it('the +2A reuses the +3\'s ROM set and page names', () => {
    expect(defaultRomPageLabel('+2A', 0)).toBe('128K Editor');
    expect(defaultRomPageLabel('+2A', 1)).toBe('128K Syntax Checker');
    expect(defaultRomPageLabel('+2A', 2)).toBe('+3DOS');
    expect(defaultRomPageLabel('+2A', 3)).toBe('48K BASIC');
  });
});
