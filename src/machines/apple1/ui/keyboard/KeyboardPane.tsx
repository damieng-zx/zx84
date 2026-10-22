/**
 * Apple I on-screen keyboard: an ASCII keyboard in the teletype arrangement, with
 * the RESET and CLEAR SCREEN keys. It borrows the Apple ][ keyboard's skin.
 */

import { For, Index, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { useApple1Keyboard, type Apple1KeyboardController } from './keyboard-common.tsx';
import { APPLE1_KEYS, APPLE1_SCENE, placeApple1Keys, type PlacedApple1Key } from './layout.ts';

function Apple1Key(props: { placed: PlacedApple1Key; keyboard: Apple1KeyboardController }) {
  const key = props.placed.key;
  const lines = key.main.split('\n');
  return (
    <SceneKey
      box={props.placed.box}
      class={`a2-key a2-key--${key.region} a2-key--${key.id}${key.shift ? ' a2-key--shifted' : ''}`}
      pressed={props.keyboard.isDown(key)}
      label={key.main.replace('\n', ' ') || 'SPACE'}
      onDown={() => props.keyboard.onDown(key)}
      onUp={() => props.keyboard.onUp(key)}
    >
      <Show when={key.region !== 'space'}>
        <span class="a2-key__legend">
          <Show when={key.shift}>
            <span class="a2-key__shift">{key.shift}</span>
          </Show>
          <Index each={lines}>{(line) => <span class="a2-key__main">{line()}</span>}</Index>
        </span>
      </Show>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const keyboard = useApple1Keyboard(() => APPLE1_KEYS);
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={APPLE1_SCENE.width}
        height={APPLE1_SCENE.height}
        unit={APPLE1_SCENE.unit}
        class="a2-keyboard a2-keyboard--apple2"
        label="Apple I keyboard"
      >
        <For each={placeApple1Keys()}>
          {(placed) => <Apple1Key placed={placed} keyboard={keyboard} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
