/**
 * Base pane component with 128K-style title bar, collapse/expand, and drag.
 *
 * A `floatable` pane can also be torn out of the layout by its title bar and
 * left free-floating over the app, where it can be resized and put back. The
 * keyboard is the pane that wants this: it is far wider than it is tall, so a
 * column is a poor place for it and its own scale is set by the width it is
 * given.
 */

import type { JSX } from 'solid-js';
import { Show, createEffect, onMount, onCleanup } from 'solid-js';
import {
  collapsedPanes, toggleCollapsed, registerResetter, unregisterResetter,
  paneFloat, setPaneFloat, dockPane,
} from '@/ui/panes.ts';

/** Keep at least this much of a floating pane reachable on screen. */
const KEEP_ON_SCREEN = 120;
/** Pointer travel before a press on the title bar counts as a drag. */
const DRAG_THRESHOLD = 4;

interface PaneProps {
  id: string;
  label: string;
  mono?: boolean;
  visible?: boolean;
  labelExtra?: JSX.Element;
  /** Allow the pane to be dragged out of the layout and float. */
  floatable?: boolean;
  /** If provided, the pane appears in the toolbar Reset menu. */
  onResetSettings?: () => void;
  children?: JSX.Element;
}

export function Pane(props: PaneProps) {
  let paneRef: HTMLDivElement | undefined;
  // Set for the pointerup that ends a drag, so releasing the title bar after
  // moving the pane does not also collapse it.
  let dragged = false;

  const float = () => (props.floatable ? paneFloat(props.id) : null);

  function onLabelClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('select, button')) return;
    if (dragged) return;
    toggleCollapsed(props.id);
  }

  function onLabelMouseDown(e: MouseEvent) {
    // Floatable panes drag themselves with pointer events below; the rest hand
    // off to the sidebar's HTML5 drag-and-drop reordering.
    if (props.floatable) return;
    if ((e.target as HTMLElement).closest('select, button')) return;
    const pane = (e.currentTarget as HTMLElement).closest('.pane') as HTMLElement;
    if (pane) {
      pane.draggable = true;
      pane.dataset.dragFromLabel = '1';
    }
  }

  function onLabelPointerDown(e: PointerEvent) {
    dragged = false;
    if (!props.floatable || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('select, button')) return;
    const pane = paneRef;
    if (!pane) return;
    const rect = pane.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    let moving = false;

    const onMove = (ev: PointerEvent) => {
      if (!moving) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < DRAG_THRESHOLD) return;
        moving = true;
        dragged = true;
        // Tear a docked pane out exactly where it stands, so it does not jump
        // out from under the pointer on the first move.
        if (!float()) setPaneFloat(props.id, { x: rect.left, y: rect.top, width: rect.width });
      }
      const maxX = window.innerWidth - KEEP_ON_SCREEN;
      const maxY = window.innerHeight - KEEP_ON_SCREEN;
      setPaneFloat(props.id, {
        x: Math.min(Math.max(ev.clientX - grabX, KEEP_ON_SCREEN - rect.width), maxX),
        y: Math.min(Math.max(ev.clientY - grabY, 0), maxY),
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // A stored position can fall outside a window that has since shrunk, so pull
  // a floating pane back into view on mount and whenever the window resizes.
  onMount(() => {
    if (!props.floatable) return;
    const clamp = () => {
      const at = float();
      if (!at) return;
      const x = Math.min(Math.max(at.x, KEEP_ON_SCREEN - at.width), window.innerWidth - KEEP_ON_SCREEN);
      const y = Math.min(Math.max(at.y, 0), window.innerHeight - KEEP_ON_SCREEN);
      if (x !== at.x || y !== at.y) setPaneFloat(props.id, { x, y });
    };
    clamp();
    window.addEventListener('resize', clamp);
    onCleanup(() => window.removeEventListener('resize', clamp));
  });

  // Expose this pane's reset handler to the toolbar Reset menu while mounted.
  onMount(() => {
    if (!props.onResetSettings) return;
    registerResetter({ id: props.id, label: props.label, reset: () => props.onResetSettings!() });
    onCleanup(() => unregisterResetter(props.id));
  });

  // Persist a floating pane's width as the user drags its resize corner. The
  // observer writes back only a width it did not just receive, so setting the
  // style from the stored value cannot feed itself.
  createEffect(() => {
    const pane = paneRef;
    if (!pane || !float()) return;
    const observer = new ResizeObserver(() => {
      const stored = float();
      if (!stored) return;
      const width = Math.round(pane.getBoundingClientRect().width);
      if (Math.abs(width - stored.width) >= 1) setPaneFloat(props.id, { width });
    });
    observer.observe(pane);
    onCleanup(() => observer.disconnect());
  });

  const floatStyle = () => {
    const at = float();
    return {
      left: at ? `${at.x}px` : undefined,
      top: at ? `${at.y}px` : undefined,
      width: at ? `${at.width}px` : undefined,
    };
  };

  return (
    <Show when={props.visible !== false}>
      <div
        id={props.id}
        ref={paneRef}
        class={`pane${props.mono ? ' pane--mono' : ''}${collapsedPanes().has(props.id) ? ' collapsed' : ''}${float() ? ' pane--floating' : ''}`}
        style={floatStyle()}
      >
        <div
          class="section-label"
          onClick={onLabelClick}
          onMouseDown={onLabelMouseDown}
          onPointerDown={onLabelPointerDown}
        >
          <svg class="twisty" width="10" height="10" viewBox="0 0 10 10">
            <path d="M2,3 L8,3 L5,8 Z" fill="currentColor" />
          </svg>
          {props.label}
          {props.labelExtra}
          <Show when={props.floatable}>
            <button
              class="pane-dock"
              title={float() ? 'Put back below the screen' : 'Float this pane'}
              aria-label={float() ? 'Dock pane' : 'Float pane'}
              onClick={(e) => {
                e.stopPropagation();
                const pane = paneRef;
                if (float() || !pane) dockPane(props.id);
                else {
                  const rect = pane.getBoundingClientRect();
                  setPaneFloat(props.id, { x: rect.left, y: rect.top, width: rect.width });
                }
              }}
            >
              {float() ? '⤡' : '⤢'}
            </button>
          </Show>
        </div>
        <div class="pane-content">
          <div class="pane-content-inner">
            {props.children}
          </div>
        </div>
      </div>
    </Show>
  );
}
