/**
 * Acorn Atom on-screen keyboard: the machine's QWERTY deck on its black plate,
 * with the green ACORN ATOM badge beside the space bar.
 */

import { For, Index, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { useAtomKeyboard, type AtomKeyboardController } from './keyboard-common.tsx';
import { ATOM_KEYS } from './layout.ts';
import {
  ATOM_BADGE_BOX, ATOM_PLATE_BOX, ATOM_SCENE, placeAtomKeys, type PlacedAtomKey,
} from './scene-geometry.ts';

function AtomKey(props: { placed: PlacedAtomKey; keyboard: AtomKeyboardController }) {
  const key = props.placed.key;
  const lines = key.main.split('\n');
  return (
    <SceneKey
      box={props.placed.box}
      class={`atom-key atom-key--${key.region}${key.shift ? ' atom-key--shifted' : ''}`}
      pressed={props.keyboard.isDown(key)}
      label={key.main.replace('\n', ' ') || 'SPACE'}
      onDown={() => props.keyboard.onDown(key)}
      onUp={() => props.keyboard.onUp(key)}
    >
      <Show when={key.region !== 'space'}>
        <span class="atom-key__legend">
          <Show when={key.shift}>
            <span class="atom-key__shift">{key.shift}</span>
          </Show>
          <Index each={lines}>{(line) => <span class="atom-key__main">{line()}</span>}</Index>
        </span>
      </Show>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const keyboard = useAtomKeyboard(() => ATOM_KEYS);
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={ATOM_SCENE.width}
        height={ATOM_SCENE.height}
        unit={1}
        fill
        class="atom-keyboard"
        label="Acorn Atom keyboard"
      >
        <SceneElement box={ATOM_PLATE_BOX} class="atom-plate" />
        <For each={placeAtomKeys()}>
          {(placed) => <AtomKey placed={placed} keyboard={keyboard} />}
        </For>
        <SceneElement box={ATOM_BADGE_BOX} class="atom-badge">
          ACORN ATOM
        </SceneElement>
      </KeyboardScene>
    </Pane>
  );
}
