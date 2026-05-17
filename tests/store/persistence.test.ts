/**
 * store/persistence — localStorage + IndexedDB orchestration.
 *
 * The functions in src/store/persistence.ts are mostly thin wrappers around
 * browser storage APIs, but the orchestration between LS (which holds the
 * filename) and IDB (which holds the bytes) carries real logic: when do we
 * skip restoration, when do we clear which side, etc. These tests probe that
 * orchestration and the surrounding error swallowing without rubber-stamping
 * the implementation.
 *
 * IndexedDB is mocked in-process. The mock is the minimal surface the
 * persistence layer uses (open / transaction / objectStore / put / get).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────
// LocalStorage mock
// ─────────────────────────────────────────────────────────────────────────

class MemStorage {
  store = new Map<string, string>();
  throwOnGet = false;
  throwOnSet = false;
  throwOnRemove = false;
  getItem(k: string): string | null {
    if (this.throwOnGet) throw new Error('SecurityError');
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.throwOnSet) throw new Error('QuotaExceededError');
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    if (this.throwOnRemove) throw new Error('SecurityError');
    this.store.delete(k);
  }
  clear(): void { this.store.clear(); }
}

// ─────────────────────────────────────────────────────────────────────────
// Minimal IndexedDB mock — only the surface persistence.ts touches.
// One named store ('roms'), in-memory key→Uint8Array, async via microtask.
// ─────────────────────────────────────────────────────────────────────────

interface MemRequest<T> {
  result?: T;
  error?: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}

function fireAsync<T>(req: MemRequest<T>, ok: boolean): void {
  queueMicrotask(() => {
    if (ok && req.onsuccess) req.onsuccess();
    else if (!ok && req.onerror) req.onerror();
  });
}

class MemDB {
  store = new Map<string, Uint8Array>();
  closed = false;
  closeCount = 0;
  failTransaction = false;
  failPutKey: string | null = null;
  failGetKey: string | null = null;

  close(): void {
    this.closed = true;
    this.closeCount++;
  }

  createObjectStore(_name: string): void {
    // no-op — single global store
  }

  transaction(_name: string, _mode: string) {
    const db = this;
    if (db.failTransaction) {
      const tx: any = { oncomplete: null, onerror: null, error: new Error('TxAborted') };
      queueMicrotask(() => tx.onerror?.());
      tx.objectStore = () => ({ put: () => {}, get: () => ({ onsuccess: null, onerror: null }) });
      return tx;
    }
    const tx: any = { oncomplete: null, onerror: null, error: null };
    let pendingError = false;
    tx.objectStore = () => ({
      put(value: Uint8Array, key: string) {
        if (db.failPutKey === key) { pendingError = true; tx.error = new Error('PutFailed'); return; }
        db.store.set(key, value);
      },
      get(key: string) {
        const req: MemRequest<Uint8Array | undefined> = { onsuccess: null, onerror: null };
        if (db.failGetKey === key) {
          req.error = new Error('GetFailed');
          fireAsync(req, false);
        } else {
          req.result = db.store.get(key); // undefined if missing — matches real IDB
          fireAsync(req, true);
        }
        return req;
      },
    });
    queueMicrotask(() => {
      if (pendingError) tx.onerror?.();
      else tx.oncomplete?.();
    });
    return tx;
  }
}

let memDB: MemDB;
let storage: MemStorage;
let failOpen = false;

function installIDB() {
  (globalThis as any).indexedDB = {
    open(_name: string, _version: number) {
      const req: MemRequest<MemDB> = { onsuccess: null, onerror: null, onupgradeneeded: null };
      if (failOpen) {
        req.error = new Error('OpenFailed');
        fireAsync(req, false);
      } else {
        req.result = memDB;
        // Fire upgradeneeded first (synchronously after caller attaches handlers)
        queueMicrotask(() => {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
      }
      return req;
    },
  };
}

beforeEach(() => {
  storage = new MemStorage();
  memDB = new MemDB();
  failOpen = false;
  (globalThis as any).localStorage = storage;
  installIDB();
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as any).localStorage;
  delete (globalThis as any).indexedDB;
});

async function load() {
  return await import('@/store/persistence.ts');
}

// ─────────────────────────────────────────────────────────────────────────
// localStorage helpers
// ─────────────────────────────────────────────────────────────────────────

describe('getSaved / setSaved', () => {
  it('namespaces every key under the "zx84-" prefix', async () => {
    const p = await load();
    p.setSaved('foo', 'bar');
    expect(storage.store.get('zx84-foo')).toBe('bar');
    expect(p.getSaved('foo', 'fallback')).toBe('bar');
  });

  it('returns the fallback when the key is missing', async () => {
    const p = await load();
    expect(p.getSaved('absent', 'fallback')).toBe('fallback');
  });

  it('returns the fallback when localStorage.getItem throws', async () => {
    const p = await load();
    storage.throwOnGet = true;
    expect(p.getSaved('foo', 'fallback')).toBe('fallback');
  });

  it('swallows quota/security errors in setSaved', async () => {
    const p = await load();
    storage.throwOnSet = true;
    expect(() => p.setSaved('foo', 'bar')).not.toThrow();
  });

  // Documenting an edge in the current contract: a stored empty string is
  // NOT replaced by the fallback. Several signals use '' as their natural
  // default (fontName), so the fallback only fires when the key is absent.
  // Pinned so a future "be helpful, treat empty as missing" change is a
  // deliberate decision rather than an accident.
  it('treats a stored empty string as the value, not as missing', async () => {
    const p = await load();
    storage.store.set('zx84-font', '');
    expect(p.getSaved('font', 'JetBrains')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// IndexedDB primitives
// ─────────────────────────────────────────────────────────────────────────

describe('dbSave / dbLoad', () => {
  it('round-trips a Uint8Array under a string key', async () => {
    const p = await load();
    const data = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    await p.dbSave('blob', data);
    const back = await p.dbLoad('blob');
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
  });

  it('returns null for a missing key', async () => {
    const p = await load();
    expect(await p.dbLoad('never-saved')).toBeNull();
  });

  it('closes the database connection after each operation', async () => {
    const p = await load();
    await p.dbSave('a', new Uint8Array([1]));
    await p.dbLoad('a');
    await p.dbLoad('missing');
    expect(memDB.closeCount).toBe(3);
  });

  it('rejects when the put transaction errors', async () => {
    const p = await load();
    memDB.failPutKey = 'doomed';
    await expect(p.dbSave('doomed', new Uint8Array([1]))).rejects.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// last-file orchestration
// ─────────────────────────────────────────────────────────────────────────

describe('persistLastFile / restoreLastFile / clearLastFile', () => {
  it('round-trips data plus filename', async () => {
    const p = await load();
    await p.persistLastFile(new Uint8Array([1, 2, 3]), 'game.sna');
    const r = await p.restoreLastFile();
    expect(r).not.toBeNull();
    expect(r!.name).toBe('game.sna');
    expect(Array.from(r!.data)).toEqual([1, 2, 3]);
  });

  it('returns null when the filename is missing (skips the IDB roundtrip)', async () => {
    const p = await load();
    // Pre-populate IDB but not LS — restore must not see the orphaned blob.
    await p.dbSave('last-file', new Uint8Array([9, 9, 9]));
    expect(await p.restoreLastFile()).toBeNull();
  });

  it('returns null when LS has the filename but IDB lost the blob', async () => {
    const p = await load();
    storage.store.set('zx84-last-file', 'orphan.sna');
    expect(await p.restoreLastFile()).toBeNull();
  });

  it('silently swallows persist failures (caller has no way to know it failed)', async () => {
    // This is the current contract: if IDB write fails or LS write throws,
    // the user thinks their last file was remembered but it wasn't. Pinned
    // so any future change to surface this failure is deliberate.
    const p = await load();
    memDB.failPutKey = 'last-file';
    await expect(p.persistLastFile(new Uint8Array([1]), 'x.sna')).resolves.toBeUndefined();
    // LS still untouched because the failure happens before the LS write.
    expect(storage.store.get('zx84-last-file')).toBeUndefined();
  });

  // SMELL: clearLastFile only removes the LS entry; the IDB blob is leaked.
  // Compare with clearTape/clearDisk which at least attempt to wipe IDB.
  // Pinned as a regression test for any future cleanup that decides to be
  // consistent with the other clear* functions.
  it('clearLastFile removes the filename but does NOT clear the IDB blob', async () => {
    const p = await load();
    await p.persistLastFile(new Uint8Array([1, 2, 3]), 'g.sna');
    p.clearLastFile();
    expect(storage.store.has('zx84-last-file')).toBe(false);
    // Blob is still there:
    expect(memDB.store.get('last-file')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// tape persistence
// ─────────────────────────────────────────────────────────────────────────

describe('persistTape / restoreTape / clearTape', () => {
  it('round-trips a tape image', async () => {
    const p = await load();
    await p.persistTape(new Uint8Array([0xAA, 0xBB]), 'game.tap');
    const r = await p.restoreTape();
    expect(r!.name).toBe('game.tap');
    expect(Array.from(r!.data)).toEqual([0xAA, 0xBB]);
  });

  it('clearTape removes the LS filename', async () => {
    const p = await load();
    await p.persistTape(new Uint8Array([1]), 'g.tap');
    p.clearTape();
    expect(storage.store.has('zx84-tape-file')).toBe(false);
  });

  it('returns null after clearTape (LS removal gates the restore)', async () => {
    const p = await load();
    await p.persistTape(new Uint8Array([1]), 'g.tap');
    p.clearTape();
    // microtask: let the async empty-array IDB write settle
    await new Promise(r => queueMicrotask(() => r(null)));
    expect(await p.restoreTape()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// disk persistence + the tape/disk asymmetry
// ─────────────────────────────────────────────────────────────────────────

describe('persistDisk / restoreDisk / clearDisk', () => {
  it('unit 0 and unit 1 use distinct keys (suffix a vs b)', async () => {
    const p = await load();
    await p.persistDisk(0, new Uint8Array([1]), 'A.dsk');
    await p.persistDisk(1, new Uint8Array([2]), 'B.dsk');
    expect(storage.store.get('zx84-disk-a-file')).toBe('A.dsk');
    expect(storage.store.get('zx84-disk-b-file')).toBe('B.dsk');
    expect(memDB.store.get('disk-a-file')).toBeDefined();
    expect(memDB.store.get('disk-b-file')).toBeDefined();
  });

  it('restoreDisk returns null when the stored blob is empty (post-clear sentinel)', async () => {
    // clearDisk writes an empty Uint8Array to IDB as a soft-delete. restoreDisk
    // must treat that as "no disk", not as "a zero-byte disk".
    const p = await load();
    await p.persistDisk(0, new Uint8Array([1, 2]), 'A.dsk');
    p.clearDisk(0);
    // Force the sentinel-but-name-present state: re-add the LS filename so
    // the early `!name` check doesn't short-circuit. This proves the empty-
    // array branch in restoreDisk is what actually rejects.
    storage.store.set('zx84-disk-a-file', 'A.dsk');
    await new Promise(r => queueMicrotask(() => r(null)));
    expect(await p.restoreDisk(0)).toBeNull();
  });

  it('restoreTape returns null when the stored blob is empty (matches restoreDisk)', async () => {
    const p = await load();
    await p.persistTape(new Uint8Array(0), 'empty.tap');
    expect(await p.restoreTape()).toBeNull();
  });
});
