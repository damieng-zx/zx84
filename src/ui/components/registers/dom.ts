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

/**
 * Class a panel puts on its root `<pre>` while the machine is paused.
 *
 * The editable bits below only react to clicks under it, so the panels need no
 * pause-state plumbing of their own beyond toggling this class.
 */
export const EDITABLE_CLASS = 'regs-editable';

const isEditable = (el: HTMLElement): boolean => el.closest(`.${EDITABLE_CLASS}`) !== null;

/**
 * Wrap a value slot so a click turns it into a hex input (paused only).
 *
 * Enter commits the typed value, Esc or losing focus cancels. The slot Text
 * stays the thing the panel updates; it is simply swapped out for the input
 * while editing and put back afterwards, so the panel's diffing is unaffected.
 */
export function makeEditable(slot: Text, digits: number, commit: (value: number) => void): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'reg-val';
  el.appendChild(slot);

  el.addEventListener('click', () => {
    if (!isEditable(el) || el.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = slot.data;
    input.maxLength = digits;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.style.width = `${digits}ch`;

    let done = false;
    const finish = (apply: boolean): void => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      el.replaceChildren(slot);
      if (apply && /^[0-9a-f]+$/i.test(text)) commit(parseInt(text, 16));
    };
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^0-9a-f]/gi, '').toUpperCase();
    });
    input.addEventListener('keydown', e => {
      e.stopPropagation(); // keep emulator hotkeys and key capture out of the box
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(false));

    el.replaceChildren(input);
    input.focus();
    input.select();
  });
  return el;
}

/** Wrap a slot so a click calls `onToggle` (paused only). */
export function makeToggle(slot: Text, tip: string, onToggle: () => void): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'reg-toggle';
  el.dataset.tip = tip;
  el.appendChild(slot);
  el.addEventListener('click', () => { if (isEditable(el)) onToggle(); });
  return el;
}

/** Create a flag span: check/unchecked + label. With `onToggle`, clicking it
 *  flips the flag while paused. */
export function makeFlag(
  label: string,
  tip: string,
  onToggle?: () => void,
): { el: HTMLSpanElement; update: (on: boolean) => void } {
  const el = document.createElement('span');
  el.dataset.tip = tip;
  if (onToggle) {
    el.classList.add('reg-toggle');
    el.addEventListener('click', () => { if (isEditable(el)) onToggle(); });
  }
  const txt = document.createTextNode('');
  el.appendChild(txt);
  let prevOn: boolean | null = null;
  return {
    el,
    update(on: boolean) {
      if (on === prevOn) return;
      prevOn = on;
      el.classList.toggle('flag-on', on);
      el.classList.toggle('flag-off', !on);
      txt.data = on ? `\u2611 ${label}` : `\u2610 ${label}`;
    },
  };
}
