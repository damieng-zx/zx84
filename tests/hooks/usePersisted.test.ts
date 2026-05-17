/**
 * usePersisted — Solid signal ↔ localStorage sync.
 *
 * The hook is a one-liner around createEffect, but it sits on top of a
 * persistSetting → setSaved → localStorage.setItem chain. These tests pin
 * three behaviours that would silently regress if the wiring broke:
 *   1. an immediate write on first run (so newly-introduced settings get
 *      saved without the user having to touch them),
 *   2. a write on every subsequent signal change, and
 *   3. graceful behaviour when localStorage is unavailable or throws.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';

class MemStorage {
  private store = new Map<string, string>();
  throwOnSet = false;
  setCalls: { key: string; value: string }[] = [];
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string): void {
    this.setCalls.push({ key: k, value: String(v) });
    if (this.throwOnSet) throw new Error('QuotaExceededError');
    this.store.set(k, String(v));
  }
  removeItem(k: string): void { this.store.delete(k); }
  clear(): void { this.store.clear(); this.setCalls = []; }
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
  return await import('@/hooks/usePersisted.ts');
}

// `usePersisted` registers an effect on the current reactive owner. Wrapping
// each test in createRoot gives the effect somewhere to live and gives us a
// dispose handle so test state doesn't leak between cases.
function withRoot<T>(fn: (dispose: () => void) => T): T {
  let result!: T;
  createRoot((dispose) => { result = fn(dispose); });
  return result;
}

// ── Initial write ─────────────────────────────────────────────────────────

describe('usePersisted — initial run', () => {
  it('writes the signal\'s current value to localStorage on first effect run', async () => {
    const { usePersisted } = await freshImport();

    withRoot(() => {
      const [sig] = createSignal<number>(42);
      usePersisted(sig, 'scale');
    });

    expect(storage.getItem('zx84-scale')).toBe('42');
    expect(storage.setCalls).toHaveLength(1);
    expect(storage.setCalls[0]).toEqual({ key: 'zx84-scale', value: '42' });
  });

  it('stringifies number signals (localStorage only stores strings)', async () => {
    const { usePersisted } = await freshImport();

    withRoot(() => {
      const [sig] = createSignal<number>(0);
      usePersisted(sig, 'brightness');
    });

    expect(storage.getItem('zx84-brightness')).toBe('0');
  });

  it('passes string signals through unchanged', async () => {
    const { usePersisted } = await freshImport();

    withRoot(() => {
      const [sig] = createSignal<string>('kempston');
      usePersisted(sig, 'joystick');
    });

    expect(storage.getItem('zx84-joystick')).toBe('kempston');
  });
});

// ── Reactivity ────────────────────────────────────────────────────────────

describe('usePersisted — signal updates', () => {
  it('writes again every time the source signal changes', async () => {
    const { usePersisted } = await freshImport();

    let setSig!: (v: number) => number;
    withRoot(() => {
      const [sig, set] = createSignal<number>(1);
      setSig = set;
      usePersisted(sig, 'scale');
    });

    expect(storage.setCalls).toHaveLength(1);
    setSig(2);
    setSig(3);
    setSig(3); // unchanged — Solid equality skips redundant updates
    expect(storage.setCalls.map(c => c.value)).toEqual(['1', '2', '3']);
    expect(storage.getItem('zx84-scale')).toBe('3');
  });

  it('keeps separate keys independent', async () => {
    const { usePersisted } = await freshImport();

    let setScale!: (v: number) => number;
    let setVolume!: (v: number) => number;
    withRoot(() => {
      const [scale, sScale] = createSignal<number>(2);
      const [volume, sVol] = createSignal<number>(50);
      setScale = sScale; setVolume = sVol;
      usePersisted(scale, 'scale');
      usePersisted(volume, 'volume');
    });

    setScale(4);
    expect(storage.getItem('zx84-scale')).toBe('4');
    expect(storage.getItem('zx84-volume')).toBe('50');

    setVolume(75);
    expect(storage.getItem('zx84-scale')).toBe('4');
    expect(storage.getItem('zx84-volume')).toBe('75');
  });

  it('stops persisting after the owner root is disposed', async () => {
    const { usePersisted } = await freshImport();

    let setSig!: (v: number) => number;
    let dispose!: () => void;
    withRoot((d) => {
      dispose = d;
      const [sig, set] = createSignal<number>(10);
      setSig = set;
      usePersisted(sig, 'scale');
    });

    expect(storage.setCalls).toHaveLength(1);
    dispose();
    setSig(20);
    setSig(30);
    // No further writes after dispose — Solid tears down the effect.
    expect(storage.setCalls).toHaveLength(1);
    expect(storage.getItem('zx84-scale')).toBe('10');
  });
});

// ── Failure modes ─────────────────────────────────────────────────────────

describe('usePersisted — localStorage failures', () => {
  it('swallows setItem exceptions so a full quota does not break the UI', async () => {
    storage.throwOnSet = true;
    const { usePersisted } = await freshImport();

    expect(() => {
      withRoot(() => {
        const [sig] = createSignal<number>(99);
        usePersisted(sig, 'scale');
      });
    }).not.toThrow();

    // The attempt was still made, even though the storage refused it.
    expect(storage.setCalls).toHaveLength(1);
  });
});
