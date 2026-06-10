/**
 * Pane order and collapse state, persisted to localStorage.
 */

import { createSignal } from 'solid-js';

export interface PanePosition {
  id: string;
  sidebar: 'left' | 'right';
}

const ORDER_KEY = 'zx84-pane-order';
const COLLAPSE_KEY = 'zx84-collapsed';
const DEVTOOLS_KEY = 'zx84-devtools-hidden';

/**
 * The developer-tools panes, shown/hidden as a single group via the toolbar
 * menu. (BASIC Listing, BASIC Variables, System Variables, Memory Layout,
 * Debugger, Memory.)
 */
export const DEV_PANES = new Set<string>([
  'sysvar-panel', 'basic-panel', 'basic-vars-panel',
  'banks-panel', 'disasm-panel', 'memory-panel', 'font-panel',
]);

// ── Default pane layout ─────────────────────────────────────────────────

const DEFAULT_ORDER: PanePosition[] = [
  // Left: core machine controls.
  { id: 'hardware-panel', sidebar: 'left' },
  { id: 'snapshot-panel', sidebar: 'left' },
  { id: 'drive-panel', sidebar: 'left' },
  { id: 'tape-panel', sidebar: 'left' },
  { id: 'game-library-panel', sidebar: 'left' },
  // Right: peripherals/output, then the dev panes (hidden by default).
  { id: 'sound-panel', sidebar: 'right' },
  { id: 'display-pane', sidebar: 'right' },
  { id: 'joystick-panel', sidebar: 'right' },
  { id: 'mouse-panel', sidebar: 'right' },
  { id: 'disk-info-panel', sidebar: 'right' },
  { id: 'font-panel', sidebar: 'right' },
  { id: 'sysvar-panel', sidebar: 'right' },
  { id: 'basic-panel', sidebar: 'right' },
  { id: 'basic-vars-panel', sidebar: 'right' },
  { id: 'banks-panel', sidebar: 'right' },
  { id: 'disasm-panel', sidebar: 'right' },
  { id: 'memory-panel', sidebar: 'right' },
  { id: 'text-panel', sidebar: 'right' },
];

/**
 * Panes that depend on Spectrum ROM/hardware specifics and are hidden when a
 * CPC is active (they read Spectrum memory layouts, paging, or peripherals).
 */
export const SPECTRUM_ONLY_PANES = new Set<string>([
  'sysvar-panel', 'basic-vars-panel',
  'font-panel',
  // The library catalogues ZX Spectrum software; hide it on a CPC.
  'game-library-panel',
]);

function loadPaneOrder(): PanePosition[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (raw) {
      const saved: PanePosition[] = JSON.parse(raw);
      // Merge: use saved order but ensure all default panes exist
      // and remove any panes no longer in defaults
      const defaultIds = new Set(DEFAULT_ORDER.map(p => p.id));
      const savedIds = new Set(saved.map(p => p.id));
      const merged = saved.filter(p => defaultIds.has(p.id));
      for (const def of DEFAULT_ORDER) {
        if (!savedIds.has(def.id)) merged.push(def);
      }
      return merged;
    }
  } catch { /* */ }
  return [...DEFAULT_ORDER];
}

const DEFAULT_COLLAPSED = new Set<string>(['sound-panel', 'mouse-panel']);

// Developer tools start hidden; the user opts in via the toolbar menu.
const DEFAULT_DEVTOOLS_HIDDEN = true;

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* */ }
  return new Set(DEFAULT_COLLAPSED);
}

function loadDevToolsHidden(): boolean {
  try {
    const raw = localStorage.getItem(DEVTOOLS_KEY);
    if (raw !== null) return raw === '1';
  } catch { /* */ }
  return DEFAULT_DEVTOOLS_HIDDEN;
}

// ── Signals ─────────────────────────────────────────────────────────────

const _paneOrder = createSignal<PanePosition[]>(loadPaneOrder());
export const paneOrder = _paneOrder[0];
const _setPaneOrder = _paneOrder[1];

const _collapsedPanes = createSignal<Set<string>>(loadCollapsed());
export const collapsedPanes = _collapsedPanes[0];
const _setCollapsedPanes = _collapsedPanes[1];

const _devToolsHidden = createSignal<boolean>(loadDevToolsHidden());
export const devToolsHidden = _devToolsHidden[0];
const _setDevToolsHidden = _devToolsHidden[1];

// ── Actions ─────────────────────────────────────────────────────────────

export function savePaneOrder(): void {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(paneOrder())); } catch { /* */ }
}

export function setPaneOrder(order: PanePosition[]): void {
  _setPaneOrder(order);
  savePaneOrder();
}

export function toggleCollapsed(id: string): void {
  const set = new Set(collapsedPanes());
  if (set.has(id)) {
    set.delete(id);
  } else {
    set.add(id);
  }
  _setCollapsedPanes(set);
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* */ }
}

export function isCollapsed(id: string): boolean {
  return collapsedPanes().has(id);
}

/** Show/hide the whole developer-tools pane group together. */
export function toggleDevTools(): void {
  const next = !devToolsHidden();
  _setDevToolsHidden(next);
  try { localStorage.setItem(DEVTOOLS_KEY, next ? '1' : '0'); } catch { /* */ }
}

/** True when a pane should be hidden because it's a dev pane and dev tools are off. */
export function isDevPaneHidden(id: string): boolean {
  return devToolsHidden() && DEV_PANES.has(id);
}

/**
 * Restore the pane layout to defaults: order + sidebars, collapse/expand state,
 * and developer-tools visibility. (Pane *settings* are reset separately via the
 * per-pane reset handlers.)
 */
export function resetLayout(): void {
  setPaneOrder([...DEFAULT_ORDER]);

  const collapsed = new Set(DEFAULT_COLLAPSED);
  _setCollapsedPanes(collapsed);
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); } catch { /* */ }

  _setDevToolsHidden(DEFAULT_DEVTOOLS_HIDDEN);
  try { localStorage.setItem(DEVTOOLS_KEY, DEFAULT_DEVTOOLS_HIDDEN ? '1' : '0'); } catch { /* */ }
}

// ── Reset registry ──────────────────────────────────────────────────────
// Each pane that supports "reset to defaults" registers its handler here while
// mounted, so the toolbar Reset menu can drive them all from one place.

export interface ResetEntry { id: string; label: string; reset: () => void; }

const _resetEntries = createSignal<ResetEntry[]>([]);
export const resetEntries = _resetEntries[0];
const _setResetEntries = _resetEntries[1];

export function registerResetter(entry: ResetEntry): void {
  _setResetEntries(prev => [...prev.filter(e => e.id !== entry.id), entry]);
}

export function unregisterResetter(id: string): void {
  _setResetEntries(prev => prev.filter(e => e.id !== id));
}

/** Reset entries ordered to match the pane layout (paneOrder), for a stable menu. */
export function orderedResetEntries(): ResetEntry[] {
  const ids = paneOrder().map(p => p.id);
  return [...resetEntries()].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

export function movePaneTo(paneId: string, targetSidebar: 'left' | 'right', beforeId: string | null): void {
  const order = paneOrder().filter(p => p.id !== paneId);
  const entry: PanePosition = { id: paneId, sidebar: targetSidebar };

  if (beforeId) {
    const idx = order.findIndex(p => p.id === beforeId);
    if (idx >= 0) {
      order.splice(idx, 0, entry);
    } else {
      order.push(entry);
    }
  } else {
    // Find last pane in target sidebar and insert after it
    let lastIdx = -1;
    for (let i = 0; i < order.length; i++) {
      if (order[i].sidebar === targetSidebar) lastIdx = i;
    }
    order.splice(lastIdx + 1, 0, entry);
  }

  setPaneOrder(order);
}
