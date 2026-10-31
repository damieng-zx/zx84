/**
 * The Commodore 64's keyboard: the dark caps of the breadbin on its beige
 * case, staggered as the real rows are, with the function keys in a column on
 * the right.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { useC64Keyboard, type C64KeyboardController } from './keyboard-common.tsx';
import { C64_KEYBOARD_SCENE, C64_KEYS, type C64KeyDef } from './layout.ts';

/** The Commodore logo on the C= key: a "C" of two arcs with the two-part flag. */
function CommodoreLogo() {
  return (
    <svg class="c64-key__logo" viewBox="262 0 508 510" aria-hidden="true">
      <path
        fill="currentColor"
        d="M572 17A245 245 0 1 0 572 491L572 361.4A124 124 0 1 1 572 146.6ZM572 151H766L675 242H572ZM572 264H675L766 355H572Z"
      />
    </svg>
  );
}

function C64Key(props: { def: C64KeyDef; keyboard: C64KeyboardController }) {
  const key = props.def;
  return (
    <SceneKey
      box={key.box}
      class={[
        'c64-key',
        key.word ? 'c64-key--word' : '',
        key.grey ? 'c64-key--grey' : '',
        key.front ? 'c64-key--front' : '',
        key.id.startsWith('crsr') ? 'c64-key--crsr' : '',
        /^f\d$/.test(key.id) ? 'c64-key--fkey' : '',
        key.shift ? 'c64-key--shifted' : '',
        key.action === 'shift-lock' ? 'c64-key--lock' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key)}
      label={key.id === 'space' ? 'SPACE' : `${key.shift ? `${key.shift} ` : ''}${key.main}`}
      onDown={() => props.keyboard.onDown(key)}
      onUp={() => props.keyboard.onUp(key)}
    >
      <span class="c64-key__legend">
        <Show when={key.shift}>
          <span class="c64-key__shift">{key.shift}</span>
        </Show>
        <Show when={key.id === 'cbm'} fallback={<span class="c64-key__main">{key.main}</span>}>
          <CommodoreLogo />
        </Show>
      </span>
      <Show when={key.front}>
        <span class="c64-key__front">{key.front}</span>
      </Show>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const keyboard = useC64Keyboard();
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={C64_KEYBOARD_SCENE.width}
        height={C64_KEYBOARD_SCENE.height}
        unit={C64_KEYBOARD_SCENE.unit}
        class="c64-keyboard"
        label="Commodore 64 keyboard"
      >
        <For each={C64_KEYS}>
          {(def) => <C64Key def={def} keyboard={keyboard} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
