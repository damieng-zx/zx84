/**
 * panes.ts — localStorage-backed pane order + collapse state.
 *
 * The module mutates Solid signals at import time, so each test
 * resets the module registry and replaces localStorage with a fake.
 * That keeps tests independent and lets us probe load-time behaviour
 * (defaults, malformed JSON, drift between saved + default sets).
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
  get size(): number { return this.store.size; }
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
  return await import('@/ui/panes.ts');
}

// ── loadPaneOrder defaults / merging ──────────────────────────────────────

describe('panes — load order', () => {
  it('returns the full default layout when storage is empty', async () => {
    const m = await freshImport();
    const order = m.paneOrder();
    // Both sidebars represented.
    expect(order.some(p => p.sidebar === 'left')).toBe(true);
    expect(order.some(p => p.sidebar === 'right')).toBe(true);
    // No duplicates.
    expect(new Set(order.map(p => p.id)).size).toBe(order.length);
    // Reading defaults should NOT persist — that would mask migrations later.
    expect(storage.getItem('zx84-pane-order')).toBeNull();
  });

  it('preserves saved order verbatim when it matches the default set', async () => {
    // Reverse the default order and verify it survives the load.
    const m1 = await freshImport();
    const defaults = m1.paneOrder();
    const reversed = [...defaults].reverse();
    storage.setItem('zx84-pane-order', JSON.stringify(reversed));
    vi.resetModules();
    const m2 = await freshImport();
    expect(m2.paneOrder().map(p => p.id)).toEqual(reversed.map(p => p.id));
  });

  it('drops saved entries that are no longer in the default set', async () => {
    const m1 = await freshImport();
    const defaults = m1.paneOrder();
    // Inject a stale pane id at the front.
    const polluted = [{ id: 'OLD_REMOVED_PANE', sidebar: 'left' }, ...defaults];
    storage.setItem('zx84-pane-order', JSON.stringify(polluted));
    vi.resetModules();
    const m2 = await freshImport();
    const ids = m2.paneOrder().map(p => p.id);
    expect(ids).not.toContain('OLD_REMOVED_PANE');
    expect(ids.length).toBe(defaults.length);
  });

  it('appends defaults that the saved order is missing', async () => {
    const m1 = await freshImport();
    const defaults = m1.paneOrder();
    // Pretend the user only ever saw the first 3 panes.
    const partial = defaults.slice(0, 3);
    storage.setItem('zx84-pane-order', JSON.stringify(partial));
    vi.resetModules();
    const m2 = await freshImport();
    const result = m2.paneOrder();
    // First three should match the partial saved order.
    expect(result.slice(0, 3).map(p => p.id)).toEqual(partial.map(p => p.id));
    // Rest should be every other default, in default order.
    const expectedRest = defaults.slice(3).map(p => p.id);
    expect(result.slice(3).map(p => p.id)).toEqual(expectedRest);
  });

  it('keeps the saved sidebar assignment when the user moved a pane', async () => {
    const m1 = await freshImport();
    const defaults = m1.paneOrder();
    const leftPane = defaults.find(p => p.sidebar === 'left')!;
    // User has dragged this pane to the right sidebar.
    const moved = defaults.map(p => p.id === leftPane.id ? { ...p, sidebar: 'right' as const } : p);
    storage.setItem('zx84-pane-order', JSON.stringify(moved));
    vi.resetModules();
    const m2 = await freshImport();
    const found = m2.paneOrder().find(p => p.id === leftPane.id)!;
    expect(found.sidebar).toBe('right');
  });

  it('falls back to defaults when storage contains malformed JSON', async () => {
    storage.setItem('zx84-pane-order', '{not valid');
    const m = await freshImport();
    // We just need a sane fallback — same count as defaults, no throw.
    expect(m.paneOrder().length).toBeGreaterThan(0);
  });
});

// ── Collapsed state ───────────────────────────────────────────────────────

describe('panes — collapsed state', () => {
  it('starts with no collapsed panes', async () => {
    const m = await freshImport();
    expect(m.collapsedPanes().size).toBe(0);
  });

  it('loads the persisted collapsed set', async () => {
    storage.setItem('zx84-collapsed', JSON.stringify(['memory-panel', 'banks-panel']));
    const m = await freshImport();
    expect(m.isCollapsed('memory-panel')).toBe(true);
    expect(m.isCollapsed('banks-panel')).toBe(true);
    expect(m.isCollapsed('display-pane')).toBe(false);
  });

  it('toggleCollapsed adds, then removes, an id', async () => {
    const m = await freshImport();
    m.toggleCollapsed('memory-panel');
    expect(m.isCollapsed('memory-panel')).toBe(true);
    m.toggleCollapsed('memory-panel');
    expect(m.isCollapsed('memory-panel')).toBe(false);
  });

  it('toggleCollapsed replaces the Set so Solid reactivity fires', async () => {
    const m = await freshImport();
    const before = m.collapsedPanes();
    m.toggleCollapsed('memory-panel');
    const after = m.collapsedPanes();
    // Solid's createSignal uses reference equality — a mutated Set wouldn't notify.
    expect(after).not.toBe(before);
  });

  it('persists collapse state across module reload', async () => {
    const m1 = await freshImport();
    m1.toggleCollapsed('memory-panel');
    vi.resetModules();
    const m2 = await freshImport();
    expect(m2.isCollapsed('memory-panel')).toBe(true);
  });

  it('swallows storage write failures rather than throwing', async () => {
    const m = await freshImport();
    storage.throwOnSet = true;
    expect(() => m.toggleCollapsed('memory-panel')).not.toThrow();
    // In-memory state still updated even though persistence failed.
    expect(m.isCollapsed('memory-panel')).toBe(true);
  });
});

// ── setPaneOrder / movePaneTo ─────────────────────────────────────────────

describe('panes — movePaneTo', () => {
  it('inserts before a target pane in the same sidebar', async () => {
    const m = await freshImport();
    const ids = m.paneOrder().map(p => p.id);
    // Grab two left-sidebar panes.
    const left = m.paneOrder().filter(p => p.sidebar === 'left').map(p => p.id);
    expect(left.length).toBeGreaterThanOrEqual(3);
    const moving = left[2];
    const target = left[0];
    m.movePaneTo(moving, 'left', target);
    const after = m.paneOrder().map(p => p.id);
    const movedIdx = after.indexOf(moving);
    const targetIdx = after.indexOf(target);
    expect(movedIdx).toBe(targetIdx - 1);
    // Source removed exactly once.
    expect(after.filter(id => id === moving).length).toBe(1);
    // No extra or lost panes.
    expect(new Set(after)).toEqual(new Set(ids));
  });

  it('with beforeId=null appends after the last entry in the target sidebar', async () => {
    const m = await freshImport();
    // Move a right-sidebar pane to the end of the left sidebar.
    const right = m.paneOrder().filter(p => p.sidebar === 'right').map(p => p.id);
    const moving = right[0];
    m.movePaneTo(moving, 'left', null);
    const order = m.paneOrder();
    // Find last 'left' index — moving pane should sit there.
    const leftPositions = order
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.sidebar === 'left');
    const last = leftPositions[leftPositions.length - 1];
    expect(last.p.id).toBe(moving);
  });

  it('changes the pane sidebar to the requested target', async () => {
    const m = await freshImport();
    const right = m.paneOrder().filter(p => p.sidebar === 'right')[0].id;
    m.movePaneTo(right, 'left', null);
    const moved = m.paneOrder().find(p => p.id === right)!;
    expect(moved.sidebar).toBe('left');
  });

  it('falls back to appending when beforeId is not in the order', async () => {
    const m = await freshImport();
    const ids = m.paneOrder().map(p => p.id);
    const moving = ids[0];
    m.movePaneTo(moving, 'left', 'no-such-pane');
    const after = m.paneOrder();
    expect(after[after.length - 1].id).toBe(moving);
  });

  it('persists the new order to localStorage', async () => {
    const m = await freshImport();
    const right = m.paneOrder().filter(p => p.sidebar === 'right')[0].id;
    m.movePaneTo(right, 'left', null);
    const raw = storage.getItem('zx84-pane-order');
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw!);
    expect(saved.find((p: any) => p.id === right).sidebar).toBe('left');
  });

  it('handles moving a pane "before itself" without losing or duplicating it', async () => {
    const m = await freshImport();
    const ids = m.paneOrder().map(p => p.id);
    const subject = ids[5];
    // beforeId is the pane itself — once filtered out, beforeId no longer
    // exists in the array, so it should fall through to append-at-end.
    m.movePaneTo(subject, m.paneOrder()[5].sidebar, subject);
    const after = m.paneOrder().map(p => p.id);
    // Exactly one copy.
    expect(after.filter(id => id === subject).length).toBe(1);
    expect(new Set(after)).toEqual(new Set(ids));
  });
});
