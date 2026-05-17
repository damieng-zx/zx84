/**
 * machine-state — localStorage-backed model persistence.
 *
 * The signal modules under src/state/ are mostly thin createSignal wrappers
 * with no logic worth pinning down. The exception is machine-state, which
 * loads/validates/migrates the saved SpectrumModel at module-init time and
 * exposes saveModel() for writing it back. That's the only place where a
 * test can plausibly surface a bug, so this file focuses there.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class MemStorage {
  private store = new Map<string, string>();
  throwOnSet = false;
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string): void {
    if (this.throwOnSet) throw new Error('QuotaExceededError');
    this.store.set(k, String(v));
  }
  removeItem(k: string): void { this.store.delete(k); }
  clear(): void { this.store.clear(); }
  get raw(): Map<string, string> { return this.store; }
}

let storage: MemStorage;

beforeEach(() => {
  storage = new MemStorage();
  (globalThis as any).localStorage = storage;
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as any).localStorage;
});

async function freshImport() {
  return await import('@/state/machine-state.ts');
}

describe('machine-state — model load/save', () => {
  it('defaults to 128k when nothing is stored', async () => {
    const m = await freshImport();
    expect(m.currentModel()).toBe('128k');
    // Default should not leak back into storage — the module reads, not writes.
    expect(storage.getItem('zx84-model')).toBeNull();
  });

  it('accepts every valid SpectrumModel string on load', async () => {
    for (const model of ['16k', '48k', '128k', '+2', '+2A', '+3']) {
      storage.clear();
      storage.setItem('zx84-model', model);
      vi.resetModules();
      const m = await freshImport();
      expect(m.currentModel()).toBe(model);
    }
  });

  it('migrates legacy "+2a" to "+2A" and writes it back to storage', async () => {
    storage.setItem('zx84-model', '+2a');
    const m = await freshImport();
    expect(m.currentModel()).toBe('+2A');
    expect(storage.getItem('zx84-model')).toBe('+2A');
  });

  it('rejects unknown values and falls back to default 128k', async () => {
    storage.setItem('zx84-model', 'pentagon');
    const m = await freshImport();
    expect(m.currentModel()).toBe('128k');
  });

  it('is case-sensitive on load (rejects "48K", "+3 ", etc.)', async () => {
    for (const bad of ['48K', '128K', '+2 ', ' +3', '']) {
      storage.clear();
      storage.setItem('zx84-model', bad);
      vi.resetModules();
      const m = await freshImport();
      expect(m.currentModel()).toBe('128k');
    }
  });

  it('clears an invalid entry from storage on load', async () => {
    storage.setItem('zx84-model', 'pentagon');
    await freshImport();
    expect(storage.getItem('zx84-model')).toBeNull();
  });

  it('saveModel writes the model under "zx84-model"', async () => {
    const m = await freshImport();
    m.saveModel('+3');
    expect(storage.getItem('zx84-model')).toBe('+3');
    m.saveModel('48k');
    expect(storage.getItem('zx84-model')).toBe('48k');
  });

  it('saveModel swallows localStorage exceptions (e.g. quota)', async () => {
    const m = await freshImport();
    storage.throwOnSet = true;
    expect(() => m.saveModel('+3')).not.toThrow();
  });

  it('load swallows localStorage exceptions and falls back to default', async () => {
    // Replace getItem with a thrower before the module runs.
    (globalThis as any).localStorage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => {},
    };
    const m = await freshImport();
    expect(m.currentModel()).toBe('128k');
  });

  it('survives the absence of localStorage entirely', async () => {
    delete (globalThis as any).localStorage;
    // loadSavedModel references localStorage inside a try/catch, so a missing
    // global should be treated the same as a thrown access error.
    const m = await freshImport();
    expect(m.currentModel()).toBe('128k');
    // saveModel must also not throw in this environment.
    expect(() => m.saveModel('48k')).not.toThrow();
  });
});

describe('machine-state — initial signal values', () => {
  it('boots in "stopped, not yet running" state', async () => {
    const m = await freshImport();
    expect(m.statusText()).toBe('Load a ROM to start');
    expect(m.emulationPaused()).toBe(false);
    expect(m.turboMode()).toBe(false);
    expect(m.romStatusText()).toBe('');
    expect(m.multifaceRomFailed()).toBe('');
    expect(m.vtx5000RomFailed()).toBe('');
  });
});
