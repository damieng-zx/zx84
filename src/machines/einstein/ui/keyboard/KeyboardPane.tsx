/**
 * Skeuomorphic UK Tatung Einstein TC-01 keyboard: the key deck alone, without
 * the case top that carried the drive bezel, lamps and badge.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { useTc01Keyboard } from './keyboard-common.tsx';
import { TC01_SCENE, placeTc01Keys, type PlacedTc01Key } from './scene-geometry.ts';

function Tc01Key(props: {
  placed: PlacedTc01Key;
  keyboard: ReturnType<typeof useTc01Keyboard>;
}) {
  const key = props.placed.key;
  const lines = () => key.main.split('\n');
  const isWord = key.main.length > 1;
  return (
    <SceneKey
      box={props.placed.box}
      class={[
        'tc01-key',
        `tc01-key--${key.tone}`,
        `tc01-key--${key.region}`,
        `tc01-key--${key.id}`,
        key.shift ? 'tc01-key--shifted' : '',
        isWord ? 'tc01-key--word' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key.cell)}
      label={key.main.replace('\n', ' ') || 'SPACE'}
      onDown={() => props.keyboard.onDown(key.cell)}
      onUp={() => props.keyboard.onUp(key.cell)}
    >
      <Show when={key.shift}>
        <span class="tc01-key__shift">{key.shift}</span>
      </Show>
      <span class="tc01-key__main">
        <For each={lines()}>{(line) => <span>{line}</span>}</For>
      </span>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const keyboard = useTc01Keyboard();
  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <KeyboardScene
        width={TC01_SCENE.width}
        height={TC01_SCENE.height}
        unit={TC01_SCENE.unit}
        class="tc01-keyboard"
        label="Tatung Einstein TC-01 keyboard"
      >
        <For each={placeTc01Keys()}>
          {(placed) => <Tc01Key placed={placed} keyboard={keyboard} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
