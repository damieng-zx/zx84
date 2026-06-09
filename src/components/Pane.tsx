/**
 * Base pane component with 128K-style title bar, collapse/expand, and drag.
 */

import type { JSX } from 'solid-js';
import { Show, onMount, onCleanup } from 'solid-js';
import {
  collapsedPanes, toggleCollapsed, registerResetter, unregisterResetter,
} from '@/ui/panes.ts';

interface PaneProps {
  id: string;
  label: string;
  mono?: boolean;
  visible?: boolean;
  labelExtra?: JSX.Element;
  /** If provided, the pane appears in the toolbar Reset menu. */
  onResetSettings?: () => void;
  children?: JSX.Element;
}

export function Pane(props: PaneProps) {
  function onLabelClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('select, button')) return;
    toggleCollapsed(props.id);
  }

  function onLabelMouseDown(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('select, button')) return;
    const pane = (e.currentTarget as HTMLElement).closest('.pane') as HTMLElement;
    if (pane) {
      pane.draggable = true;
      pane.dataset.dragFromLabel = '1';
    }
  }

  // Expose this pane's reset handler to the toolbar Reset menu while mounted.
  onMount(() => {
    if (!props.onResetSettings) return;
    registerResetter({ id: props.id, label: props.label, reset: () => props.onResetSettings!() });
    onCleanup(() => unregisterResetter(props.id));
  });

  return (
    <Show when={props.visible !== false}>
      <div id={props.id} class={`pane${props.mono ? ' pane--mono' : ''}${collapsedPanes().has(props.id) ? ' collapsed' : ''}`}>
        <div class="section-label" onClick={onLabelClick} onMouseDown={onLabelMouseDown}>
          <svg class="twisty" width="10" height="10" viewBox="0 0 10 10">
            <path d="M2,3 L8,3 L5,8 Z" fill="currentColor" />
          </svg>
          {props.label}
          {props.labelExtra}
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
