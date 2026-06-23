/**
 * Toolbar "⋮" menu: toggle individual panes on/off, reset individual pane
 * settings (or all of them), and reset local storage.
 */

import { createSignal, createEffect, onCleanup, Show, For } from 'solid-js';
import { HiOutlineEllipsisVertical } from 'solid-icons/hi';
import {
  isPaneUserHidden, togglePaneVisibility, paneOrder, PANE_LABELS,
  orderedResetEntries, resetLayout, type ResetEntry,
} from '@/ui/panes.ts';

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

  function resetOne(e: ResetEntry) {
    e.reset();
    close();
  }

  function resetAll() {
    for (const e of orderedResetEntries()) e.reset();
    resetLayout();
    close();
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
          <div class="ddmenu-item ddmenu-parent">
            <span class="ddmenu-check" />Panes
            <span class="ddmenu-arrow">{'▸'}</span>
            <div class="ddmenu ddmenu-sub">
              <For each={paneOrder().filter(p => PANE_LABELS[p.id])}>{(p) => (
                <div class="ddmenu-item" onClick={() => togglePaneVisibility(p.id)}>
                  <span class="ddmenu-check">{isPaneUserHidden(p.id) ? '' : '✓'}</span>{PANE_LABELS[p.id]}
                </div>
              )}</For>
            </div>
          </div>
          <div class="ddmenu-separator" />
          <div class="ddmenu-item ddmenu-parent">
            <span class="ddmenu-check" />Reset settings
            <span class="ddmenu-arrow">{'▸'}</span>
            <div class="ddmenu ddmenu-sub">
              <For each={orderedResetEntries()}>{(e) => (
                <div class="ddmenu-item" onClick={() => resetOne(e)}>{e.label}</div>
              )}</For>
              <div class="ddmenu-separator" />
              <div class="ddmenu-item" onClick={resetAll}>All</div>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
