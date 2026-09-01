/**
 * Shared DOM plumbing for the debugger's register panels.
 *
 * Every panel builds its DOM once on mount and then writes text nodes directly
 * from a createEffect — Solid never re-renders them, so a paused debugger costs
 * no reconciliation. These are the primitives all CPU families reuse; the
 * layout itself is per-family (see Z80Registers.tsx / GenericRegisters.tsx).
 */

import { HEX8, HEX16 } from '@/utils/hex.ts';

/** Update text node only if numeric value changed; returns new prev */
export function set16(node: Text, val: number, prev: number): number {
  if (val !== prev) node.data = HEX16[val];
  return val;
}

export function set8(node: Text, val: number, prev: number): number {
  if (val !== prev) node.data = HEX8[val];
  return val;
}

export function set8x2(node: Text, hi: number, lo: number, prev: number): number {
  const val = (hi << 8) | lo;
  if (val !== prev) node.data = HEX8[hi] + HEX8[lo];
  return val;
}

export function setStr(node: Text, val: string, prev: string): string {
  if (val !== prev) node.data = val;
  return val;
}

/** Create a <span class="reg-name" data-tip="...">label</span> */
export function makeLabel(label: string, tip: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'reg-name';
  el.dataset.tip = tip;
  el.textContent = label;
  return el;
}

/** Create a text node we'll update each frame */
export function makeSlot(): Text {
  return document.createTextNode('');
}

/** Create a flag span: check/unchecked + label */
export function makeFlag(label: string, tip: string): { el: HTMLSpanElement; update: (on: boolean) => void } {
  const el = document.createElement('span');
  el.dataset.tip = tip;
  const txt = document.createTextNode('');
  el.appendChild(txt);
  let prevOn: boolean | null = null;
  return {
    el,
    update(on: boolean) {
      if (on === prevOn) return;
      prevOn = on;
      el.className = on ? 'flag-on' : 'flag-off';
      txt.data = on ? `\u2611 ${label}` : `\u2610 ${label}`;
    },
  };
}
