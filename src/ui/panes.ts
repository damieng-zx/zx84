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
const HIDDEN_KEY = 'zx84-panes-hidden';
const LIBRARY_KEY = 'zx84-library-visible';

/**
 * Panes hidden from the sidebar by default — the developer/debugging panes.
 * Each can be re-shown individually via the toolbar "Panes" menu.
 */
export const DEV_PANES = new Set<string>([
  'sysvar-panel', 'basic-panel', 'basic-vars-panel',
  'banks-panel', 'disasm-panel', 'memory-panel', 'font-panel',
]);

/**
 * Human-readable pane labels for the toolbar "Panes" menu. Keep in sync with
 * the `label` prop passed to each `<Pane>` in its component.
 */
export const PANE_LABELS: Record<string, string> = {
  'hardware-panel': 'Hardware',
  'snapshot-panel': 'Load / Save',
  'rom-panel': 'ROM / Carts',
  'drive-panel': 'Drives',
  'microdrive-panel': 'Microdrives',
  'tape-panel': 'Tape',
  'sound-panel': 'Sound',
  'display-pane': 'Display',
  'monitor-pane': 'Monitor',
  'joystick-panel': 'Joysticks',
  'mouse-panel': 'Mouse',
  'font-panel': 'Fonts',
  'sysvar-panel': 'System Variables',
  'basic-panel': 'BASIC Listing',
  'basic-vars-panel': 'BASIC Variables',
  'banks-panel': 'Memory Layout',
  'disasm-panel': 'Debugger',
  'memory-panel': 'Memory',
  'text-panel': 'Text',
  'keyboard-panel': 'Keyboard',
};

// ── Default pane layout ─────────────────────────────────────────────────

const DEFAULT_ORDER: PanePosition[] = [
  // Left: core machine controls.
  { id: 'hardware-panel', sidebar: 'left' },
  { id: 'snapshot-panel', sidebar: 'left' },
  { id: 'rom-panel', sidebar: 'left' },
  { id: 'drive-panel', sidebar: 'left' },
  { id: 'microdrive-panel', sidebar: 'left' },
  { id: 'tape-panel', sidebar: 'left' },
  // Right: peripherals/output, then the dev panes (hidden by default).
  { id: 'sound-panel', sidebar: 'right' },
  { id: 'display-pane', sidebar: 'right' },
  { id: 'monitor-pane', sidebar: 'right' },
  // The keyboard pane lives under the screen in #main, not a sidebar — it has
  // no PANE_COMPONENTS entry so it never renders in a sidebar. It's listed here
  // only so it appears in the "Panes" show/hide menu (sidebar value unused).
  { id: 'keyboard-panel', sidebar: 'right' },
  { id: 'joystick-panel', sidebar: 'right' },
  { id: 'mouse-panel', sidebar: 'right' },
  { id: 'font-panel', sidebar: 'right' },
  { id: 'sysvar-panel', sidebar: 'right' },
  { id: 'basic-panel', sidebar: 'right' },
  { id: 'basic-vars-panel', sidebar: 'right' },
  { id: 'banks-panel', sidebar: 'right' },
  { id: 'disasm-panel', sidebar: 'right' },
  { id: 'memory-panel', sidebar: 'right' },
  { id: 'text-panel', sidebar: 'right' },
];

// Panes that depend on machine-specific memory layouts/peripherals and are
// hidden per machine are now declared by each machine's descriptor
// (`descriptor.ui.hiddenPanes`) and applied generically in app.tsx — no
// machine-kind list lives here any more.

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

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* */ }
  return new Set(DEFAULT_COLLAPSED);
}

/**
 * Per-pane visibility chosen by the user via the toolbar "Panes" menu. Defaults
 * to the dev/debug panes being hidden. Migrates the legacy single dev-tools
 * toggle (`zx84-devtools-hidden`) on first read.
 */
function loadUserHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (raw) return new Set(JSON.parse(raw));
    const legacy = localStorage.getItem('zx84-devtools-hidden');
    if (legacy !== null) return legacy === '1' ? new Set(DEV_PANES) : new Set();
  } catch { /* */ }
  return new Set(DEV_PANES);
}

// The Software Library pane is hidden by default; summon it via the Library
// button in the Load/Save pane.
function loadLibraryVisible(): boolean {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (raw !== null) return raw === '1';
  } catch { /* */ }
  return false;
}

// ── Signals ─────────────────────────────────────────────────────────────

const _paneOrder = createSignal<PanePosition[]>(loadPaneOrder());
export const paneOrder = _paneOrder[0];
const _setPaneOrder = _paneOrder[1];

const _collapsedPanes = createSignal<Set<string>>(loadCollapsed());
export const collapsedPanes = _collapsedPanes[0];
const _setCollapsedPanes = _collapsedPanes[1];

const _userHiddenPanes = createSignal<Set<string>>(loadUserHidden());
export const userHiddenPanes = _userHiddenPanes[0];
const _setUserHiddenPanes = _userHiddenPanes[1];

const _libraryVisible = createSignal<boolean>(loadLibraryVisible());
export const libraryVisible = _libraryVisible[0];
const _setLibraryVisible = _libraryVisible[1];

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

/** Show/hide a single pane (toggled from the toolbar "Panes" menu). */
export function togglePaneVisibility(id: string): void {
  const set = new Set(userHiddenPanes());
  if (set.has(id)) set.delete(id); else set.add(id);
  _setUserHiddenPanes(set);
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set])); } catch { /* */ }
}

/** Show/hide the Software Library pane (toggled from the Load/Save pane). */
export function toggleLibrary(): void {
  const next = !libraryVisible();
  _setLibraryVisible(next);
  try { localStorage.setItem(LIBRARY_KEY, next ? '1' : '0'); } catch { /* */ }
}

/** True when the user has hidden a pane via the toolbar "Panes" menu. */
export function isPaneUserHidden(id: string): boolean {
  return userHiddenPanes().has(id);
}

/**
 * Restore the pane layout to defaults: order + sidebars, collapse/expand state,
 * and per-pane visibility. (Pane *settings* are reset separately via the
 * per-pane reset handlers.)
 */
export function resetLayout(): void {
  setPaneOrder([...DEFAULT_ORDER]);

  const collapsed = new Set(DEFAULT_COLLAPSED);
  _setCollapsedPanes(collapsed);
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); } catch { /* */ }

  const hidden = new Set(DEV_PANES);
  _setUserHiddenPanes(hidden);
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch { /* */ }
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
