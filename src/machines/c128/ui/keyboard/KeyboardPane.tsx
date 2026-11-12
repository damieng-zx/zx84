/**
 * The Commodore 128's keyboard: the breadbin caps (`shared/ui/cbm-keyboard`),
 * which are the 64's matrix, and under them the keys the 128 adds: ESC, TAB,
 * ALT, HELP, LINE FEED and NO SCROLL; the four cursor keys and the keypad
 * (line K0-K2 of the matrix); and the two latching keys, CAPS LOCK and the
 * 40/80 DISPLAY key. In C64 mode the extra lines are not scanned, as on the
 * real machine, so these keys do nothing there.
 */

import { createSignal, For, onCleanup, onMount } from 'solid-js';
import { CbmKeyboardPane } from '@/machines/shared/ui/cbm-keyboard/CbmKeyboardPane.tsx';
import { activeC128 } from '@/machines/c128/ui/active.ts';

interface ExtraKey { readonly name: string; readonly label: string; readonly title: string }

const TOP_ROW: readonly ExtraKey[] = [
  { name: 'esc', label: 'ESC', title: 'ESC (host F9)' },
  { name: 'tab', label: 'TAB', title: 'TAB' },
  { name: 'alt', label: 'ALT', title: 'ALT (host right Alt)' },
  { name: 'help', label: 'HELP', title: 'HELP (host F10)' },
  { name: 'linefeed', label: 'LINE FEED', title: 'LINE FEED' },
  { name: 'no-scroll', label: 'NO SCROLL', title: 'NO SCROLL (host Scroll Lock)' },
  { name: 'up', label: '↑', title: 'Cursor up' },
  { name: 'down', label: '↓', title: 'Cursor down' },
  { name: 'left', label: '←', title: 'Cursor left' },
  { name: 'right', label: '→', title: 'Cursor right' },
];

const KEYPAD: readonly ExtraKey[] = [
  { name: 'kp7', label: '7', title: 'Keypad 7' }, { name: 'kp8', label: '8', title: 'Keypad 8' },
  { name: 'kp9', label: '9', title: 'Keypad 9' }, { name: 'kp+', label: '+', title: 'Keypad +' },
  { name: 'kp4', label: '4', title: 'Keypad 4' }, { name: 'kp5', label: '5', title: 'Keypad 5' },
  { name: 'kp6', label: '6', title: 'Keypad 6' }, { name: 'kp-', label: '−', title: 'Keypad -' },
  { name: 'kp1', label: '1', title: 'Keypad 1' }, { name: 'kp2', label: '2', title: 'Keypad 2' },
  { name: 'kp3', label: '3', title: 'Keypad 3' }, { name: 'kp-enter', label: 'ENTER', title: 'Keypad ENTER' },
  { name: 'kp0', label: '0', title: 'Keypad 0' }, { name: 'kp.', label: '.', title: 'Keypad .' },
];

function Extras() {
  const [held, setHeld] = createSignal<ReadonlySet<string>>(new Set());
  const [caps, setCaps] = createSignal(false);
  const [is80, setIs80] = createSignal(false);

  onMount(() => {
    let raf = 0;
    const tick = () => {
      const m = activeC128();
      if (m) {
        const next = new Set<string>();
        for (const k of [...TOP_ROW, ...KEYPAD]) if (m.keyboard.isPressed(k.name)) next.add(k.name);
        const was = held();
        let changed = next.size !== was.size;
        if (!changed) for (const n of next) if (!was.has(n)) { changed = true; break; }
        if (changed) setHeld(next);
        setCaps(m.keyboard.capsLock);
        setIs80(m.keyboard.display80);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  const key = (k: ExtraKey) => (
    <button
      type="button"
      class="c128-xkey"
      classList={{ 'c128-xkey--down': held().has(k.name) }}
      title={k.title}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        activeC128()?.keyboard.setKey(k.name, true);
      }}
      onPointerUp={() => activeC128()?.keyboard.setKey(k.name, false)}
      onPointerCancel={() => activeC128()?.keyboard.setKey(k.name, false)}
    >
      {k.label}
    </button>
  );

  return (
    <div class="c128-extras">
      <div class="c128-extras__row">
        <button
          type="button"
          class="c128-xkey c128-xkey--latch"
          classList={{ 'c128-xkey--down': caps() }}
          title="CAPS LOCK: a latching key the 8502 reads on its port (host Caps Lock)"
          onClick={() => activeC128()?.keyboard.toggleCapsLock()}
        >
          CAPS LOCK
        </button>
        <button
          type="button"
          class="c128-xkey c128-xkey--latch"
          classList={{ 'c128-xkey--down': is80() }}
          title="The 40/80 DISPLAY key: down for the 80-column display (host Pause)"
          onClick={() => activeC128()?.keyboard.toggleDisplay80()}
        >
          40/80
        </button>
        <For each={TOP_ROW}>{key}</For>
      </div>
      <div class="c128-extras__pad">
        <For each={KEYPAD}>{key}</For>
      </div>
    </div>
  );
}

export function KeyboardPane() {
  return <CbmKeyboardPane active={activeC128} label="Commodore 128 keyboard" extra={<Extras />} />;
}
