/**
 * Toolbar "⋮" menu: toggle individual panes on/off, reset individual pane
 * settings (or all of them), and reset local storage.
 */

import { createSignal, createEffect, onCleanup, Show, For } from 'solid-js';
import { HiOutlineEllipsisVertical } from 'solid-icons/hi';
import {
  isPaneUserHidden, togglePaneVisibility, paneOrder, PANE_LABELS,
  PANE_GROUP_ORDER, PANE_GROUPS,
  orderedResetEntries,
} from '@/ui/panes.ts';
import { pauseOnFocusLost, setPauseOnFocusLost, persistSetting } from '@/store/settings.ts';
import { factoryReset } from '@/store/persistence.ts';

export function AppMenu() {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ top: 0, left: 0 });
  let menuRef!: HTMLDivElement;
  let btnRef!: HTMLButtonElement;

  function toggle() {
    if (open()) { setOpen(false); return; }
    const r = btnRef.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.right });
    setOpen(true);
  }

  function close() { setOpen(false); }

  function resetGroup(group: string) {
    for (const e of orderedResetEntries()) {
      if (PANE_GROUPS[e.id] === group) e.reset();
    }
    close();
  }

  async function resetAll() {
    close();
    // A true factory reset: wipe ALL persisted state for this origin (every
    // localStorage key + the whole IndexedDB), not just the settings we can
    // enumerate. This is the only thing that clears a corrupt cached ROM or any
    // stale/unknown key. Reload afterwards so the app rebuilds from defaults and
    // re-fetches ROMs from the CDN. Confirm first — it also drops saved disks,
    // tapes and snapshots.
    if (!confirm('Reset everything and reload?\n\nThis clears all settings, cached ROMs, and saved disks/tapes/snapshots for this site.')) return;
    await factoryReset();
    location.reload();
  }

  function togglePauseOnFocusLost() {
    const next = !pauseOnFocusLost();
    setPauseOnFocusLost(next);
    persistSetting('pause-on-blur', next ? 'on' : 'off');
  }

  // Close on outside click or Escape (toggling panes keeps the menu open).
  createEffect(() => {
    if (!open()) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef && !menuRef.contains(e.target as Node) &&
          btnRef && !btnRef.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    });
  });

  return (
    <>
      <button ref={btnRef} class="logo-menu" title="App menu"
        onClick={(e) => { e.stopPropagation(); toggle(); }}>
        <HiOutlineEllipsisVertical />
      </button>
      <Show when={open()}>
        <div
          ref={menuRef}
          class="ddmenu"
          style={{ top: `${pos().top}px`, left: `${pos().left}px`, transform: 'translateX(-100%)' }}
        >
          <div class="ddmenu-item" onClick={togglePauseOnFocusLost}>
            <span class="ddmenu-check">{pauseOnFocusLost() ? '✓' : ''}</span>Pause when focus lost
          </div>
          <div class="ddmenu-separator" />
          <For each={PANE_GROUP_ORDER}>{(group) => {
            const panes = paneOrder().filter(p => PANE_GROUPS[p.id] === group && PANE_LABELS[p.id]);
            if (panes.length === 0) return null;
            return (
              <div class="ddmenu-item ddmenu-parent">
                <span class="ddmenu-check" />{group}
                <span class="ddmenu-arrow">{'▸'}</span>
                <div class="ddmenu ddmenu-sub">
                  <For each={panes}>{(p) => (
                    <div class="ddmenu-item" onClick={() => togglePaneVisibility(p.id)}>
                      <span class="ddmenu-check">{isPaneUserHidden(p.id) ? '' : '✓'}</span>{PANE_LABELS[p.id]}
                    </div>
                  )}</For>
                  <div class="ddmenu-separator" />
                  <div class="ddmenu-item" onClick={() => resetGroup(group)}><span class="ddmenu-check" />Reset settings</div>
                </div>
              </div>
            );
          }}</For>
          <div class="ddmenu-separator" />
          <div class="ddmenu-item" onClick={resetAll}><span class="ddmenu-check" />Reset all settings</div>
        </div>
      </Show>
    </>
  );
}
