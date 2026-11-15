/**
 * The Commodore 128's keyboard, drawn as the machine has it (`./layout.ts`):
 * the 64's matrix in the main block on cream caps, and around it the keys the
 * 128 adds on grey ones — ESC, TAB, ALT, HELP, LINE FEED, NO SCROLL, the four
 * cursor arrows and the keypad, and the two latching keys, CAPS LOCK and
 * 40/80 DISPLAY. In C64 mode the extra lines are not scanned, as on the real
 * machine, so those keys do nothing there.
 */

import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { CbmOnScreenKeys } from '@/machines/shared/ui/cbm-keyboard/pad.ts';
import { activeC128 } from '@/machines/c128/ui/active.ts';
import {
  C128_KEYBOARD_SCENE, C128_KEYS, isLatch, type C128KeyDef,
} from './layout.ts';

/** The Commodore logo on the C= key: a "C" of two arcs with the two-part flag. */
function CommodoreLogo() {
  return (
    <svg class="c128-key__logo" viewBox="262 0 508 510" aria-hidden="true">
      <path
        fill="currentColor"
        d="M572 17A245 245 0 1 0 572 491L572 361.4A124 124 0 1 1 572 146.6ZM572 151H766L675 242H572ZM572 264H675L766 355H572Z"
      />
    </svg>
  );
}

/** What a cap says, for the screen reader. */
function labelOf(key: C128KeyDef): string {
  if (key.lines) return key.lines.join(' ');
  if (key.id === 'space') return 'SPACE';
  const shift = !isLatch(key) && key.shift ? `${key.shift} ` : '';
  return `${shift}${key.main}`;
}

function C128Key(props: {
  def: C128KeyDef;
  lit: (key: C128KeyDef) => boolean;
  onDown: (key: C128KeyDef) => void;
  onUp: (key: C128KeyDef) => void;
}) {
  const key = props.def;
  const matrix = isLatch(key) ? null : key;
  const shift = matrix?.shift;
  const front = matrix?.front;
  const lines = key.lines;
  return (
    <SceneKey
      box={key.box}
      class={[
        'c128-key',
        key.word ? 'c128-key--word' : '',
        key.grey ? 'c128-key--grey' : '',
        front ? 'c128-key--front' : '',
        lines || (shift && key.word) ? 'c128-key--stack' : '',
        shift && !key.word ? 'c128-key--shifted' : '',
        key.id.startsWith('crsr') ? 'c128-key--crsr' : '',
        key.id === 'kp-enter' ? 'c128-key--enter' : '',
        key.id === 'space' ? 'c128-key--space' : '',
        key.action === 'shift-lock' || key.action === 'caps-lock' || key.action === 'display-80' ? 'c128-key--lock' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.lit(key)}
      label={labelOf(key)}
      onDown={() => props.onDown(key)}
      onUp={() => props.onUp(key)}
    >
      <span class="c128-key__legend">
        <Show when={lines} fallback={
          <>
            <Show when={shift}><span class="c128-key__shift">{shift}</span></Show>
            <Show when={key.id === 'cbm'} fallback={<span class="c128-key__main">{key.main}</span>}>
              <CommodoreLogo />
            </Show>
          </>
        }>
          <For each={lines}>{(line) => <span class="c128-key__line">{line}</span>}</For>
        </Show>
      </span>
      <Show when={front}>
        <span class="c128-key__front">{front}</span>
      </Show>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const [lit, setLit] = createSignal<ReadonlySet<string>>(new Set());
  let pad: CbmOnScreenKeys | null = null;
  let padFor: unknown = null;

  /** The pad for the machine that is running now (a model switch makes a new one). */
  const current = (): CbmOnScreenKeys | null => {
    const m = activeC128();
    if (!m) return null;
    if (padFor !== m) {
      pad?.releaseAll();
      pad = new CbmOnScreenKeys(m.keyboard);
      padFor = m;
    }
    return pad;
  };

  const isLit = (key: C128KeyDef): boolean => {
    const m = activeC128();
    if (!m) return false;
    if (isLatch(key)) return key.action === 'caps-lock' ? m.keyboard.capsLock : m.keyboard.display80;
    return current()?.lit(key) ?? false;
  };

  onMount(() => {
    let raf = 0;
    const tick = () => {
      const next = new Set<string>();
      for (const key of C128_KEYS) if (isLit(key)) next.add(key.id);
      const was = lit();
      let changed = next.size !== was.size;
      if (!changed) for (const id of next) if (!was.has(id)) { changed = true; break; }
      if (changed) setLit(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      pad?.releaseAll();
    });
  });

  const onDown = (key: C128KeyDef): void => {
    if (!isLatch(key)) current()?.press(key);
    else if (key.action === 'caps-lock') activeC128()?.keyboard.toggleCapsLock();
    else activeC128()?.keyboard.toggleDisplay80();
  };
  const onUp = (key: C128KeyDef): void => {
    if (!isLatch(key)) current()?.release(key);
  };

  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={C128_KEYBOARD_SCENE.width}
        height={C128_KEYBOARD_SCENE.height}
        unit={C128_KEYBOARD_SCENE.unit}
        class="c128-keyboard"
        label="Commodore 128 keyboard"
      >
        <For each={C128_KEYS}>
          {(def) => <C128Key def={def} lit={(k) => lit().has(k.id)} onDown={onDown} onUp={onUp} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
