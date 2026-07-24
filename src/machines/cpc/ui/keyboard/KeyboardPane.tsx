/**
 * Skeuomorphic UK Amstrad CPC 464 keyboard.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { currentModel } from '@/state/machine-state.ts';
import { useCpcKeyboard } from './keyboard-common.tsx';
import { CPC464_SCENE, placeCpc464Keys } from './scene-geometry.ts';
import type { PlacedCpcKey } from './scene-geometry.ts';
import type { CpcKeyboardController } from './keyboard-common.tsx';

function CpcKey(props: { placed: PlacedCpcKey; keyboard: CpcKeyboardController }) {
  const key = props.placed.key;
  const lines = () => key.main.split('\n');
  return (
    <SceneKey
      box={props.placed.box}
      class={[
        'cpc464-key',
        `cpc464-key--${key.tone ?? 'dark'}`,
        `cpc464-key--${props.placed.region}`,
        key.tall ? 'cpc464-key--tall' : '',
        key.main.length > 2 ? 'cpc464-key--word' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key.cell)}
      label={key.main.replace('\n', ' ') || 'SPACE'}
      onDown={() => props.keyboard.onDown(key.cell)}
      onUp={() => props.keyboard.onUp(key.cell)}
    >
      <Show when={key.shift}>
        <span class="cpc464-key__shift">{key.shift}</span>
      </Show>
      <Show when={key.fn}>
        <span class="cpc464-key__fn">{key.fn}</span>
      </Show>
      <span class="cpc464-key__main">
        <For each={lines()}>{(line) => <span>{line || '\u00a0'}</span>}</For>
      </span>
    </SceneKey>
  );
}

function Cpc464Keyboard() {
  const keyboard = useCpcKeyboard();
  const keys = placeCpc464Keys();
  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <KeyboardScene
        width={CPC464_SCENE.width}
        height={CPC464_SCENE.height}
        unit={CPC464_SCENE.unit}
        class="cpc464-keyboard"
        label="Amstrad CPC 464 keyboard"
      >
        <SceneElement box={{ x: 18, y: 7, width: 180, height: 25 }} class="cpc464-brand">
          AMSTRAD
        </SceneElement>
        <SceneElement box={{ x: 412, y: 9, width: 228, height: 22 }} class="cpc464-model">
          <span>CPC 464</span>
          <i class="cpc464-colour-bars" />
          <small>COLOUR</small>
        </SceneElement>
        <For each={keys}>
          {(placed) => <CpcKey placed={placed} keyboard={keyboard} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}

export function KeyboardPane() {
  return (
    <Show when={currentModel() === 'cpc464'}>
      <Cpc464Keyboard />
    </Show>
  );
}
