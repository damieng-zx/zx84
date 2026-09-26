/**
 * Skeuomorphic BBC Micro Model B keyboard: the red function-key strip and the
 * main QWERTY deck.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { resetMachine } from '@/shell/lifecycle.ts';
import { useBbcKeyboard } from './keyboard-common.tsx';
import type { BbcKeyboardController } from './keyboard-common.tsx';
import { BBC_SCENE, placeBbcKeys, type PlacedBbcKey } from './scene-geometry.ts';

function BbcKey(props: { placed: PlacedBbcKey; keyboard: BbcKeyboardController }) {
  const key = props.placed.key;
  const lines = () => key.main.split('\n');
  const isWord = key.main.length > 1;
  return (
    <SceneKey
      box={props.placed.box}
      class={[
        'bbc-key',
        `bbc-key--${key.region ?? 'alpha'}`,
        key.shift ? 'bbc-key--shifted' : '',
        isWord ? 'bbc-key--word' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key)}
      label={key.main.replace('\n', ' ')}
      onDown={() => {
        if (key.id === 'break') { resetMachine(); return; }
        props.keyboard.onDown(key);
      }}
      onUp={() => props.keyboard.onUp(key)}
    >
      <Show when={key.shift}>
        <span class="bbc-key__shift">{key.shift}</span>
      </Show>
      <span class="bbc-key__main">
        <For each={lines()}>{(line) => <span>{line}</span>}</For>
      </span>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const keyboard = useBbcKeyboard();
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={BBC_SCENE.width}
        height={BBC_SCENE.height}
        unit={1}
        class="bbc-keyboard"
        frameClass="bbc-keyboard-frame"
        label="BBC Micro Model B keyboard"
      >
        <For each={placeBbcKeys()}>
          {(placed) => <BbcKey placed={placed} keyboard={keyboard} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
