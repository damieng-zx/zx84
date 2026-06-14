/**
 * Transient status toast.
 *
 * The old persistent status line was removed (StatusBar). Its messages still
 * matter — errors, save/load confirmations, ROM-fetch results — so this watches
 * the same `statusText` signal and surfaces a fresh message as a brief pop-up
 * that auto-dismisses (errors linger longer and tint red), then fades. Pure
 * lifecycle chatter the old line repeated constantly is suppressed.
 */

import { createEffect, createSignal, Show, onCleanup } from 'solid-js';
import { statusText } from '@/emulator.ts';

// Redundant lifecycle messages — never worth a toast.
const SUPPRESS = new Set(['Running', 'Reset', 'ROM loaded']);

// Error-ish messages linger longer and tint red.
const ERROR_RE = /error|invalid|failed|unknown|unsupported|unavailable|too small|requires|not enabled|not loaded|no machine|no cpc|accepts|is empty|not a recognised|needs a|load a rom/i;

const NORMAL_MS = 3000;
const ERROR_MS = 6000;
const FADE_MS = 250;

export function Toast() {
  const [msg, setMsg] = createSignal('');
  const [isError, setIsError] = createSignal(false);
  const [leaving, setLeaving] = createSignal(false);
  let hideTimer = 0;
  let removeTimer = 0;
  let first = true;

  createEffect(() => {
    const text = statusText();
    // Skip the signal's initial value on mount — only react to real changes.
    if (first) { first = false; return; }
    if (!text || SUPPRESS.has(text)) return;
    const err = ERROR_RE.test(text);
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    setLeaving(false);
    setIsError(err);
    setMsg(text);
    hideTimer = window.setTimeout(() => {
      setLeaving(true);                                   // fade out
      removeTimer = window.setTimeout(() => setMsg(''), FADE_MS);
    }, err ? ERROR_MS : NORMAL_MS);
  });

  onCleanup(() => { clearTimeout(hideTimer); clearTimeout(removeTimer); });

  function dismiss() {
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    setMsg('');
  }

  return (
    <Show when={msg()}>
      <div
        class={`toast${isError() ? ' toast-error' : ''}${leaving() ? ' toast-leaving' : ''}`}
        title="Dismiss"
        onClick={dismiss}
      >
        {msg()}
      </div>
    </Show>
  );
}
