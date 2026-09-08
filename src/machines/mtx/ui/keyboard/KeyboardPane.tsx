/**
 * Skeuomorphic Memotech MTX keyboard: the key deck and its badge strip. The
 * MTX500, MTX512 and RS128 share the deck, so only the badge's model name
 * changes between them.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { currentModel } from '@/state/machine-state.ts';
import { useMtxKeyboard } from './keyboard-common.tsx';
import type { MtxKeyboardController } from './keyboard-common.tsx';
import {
  MTX_BADGE,
  MTX_SCENE,
  placeMtxKeys,
  type PlacedMtxKey,
} from './scene-geometry.ts';

const BADGE_NAMES: Record<string, string> = {
  mtx500: 'MTX500',
  mtx512: 'MTX512',
  rs128: 'RS128',
};

function MtxKey(props: { placed: PlacedMtxKey; keyboard: MtxKeyboardController }) {
  const key = props.placed.key;
  const lines = () => key.main.split('\n');
  const isWord = key.main.length > 1;
  return (
    <SceneKey
      box={props.placed.box}
      class={[
        'mtx-key',
        `mtx-key--${key.region}`,
        `mtx-key--${key.id}`,
        key.shift ? 'mtx-key--shifted' : '',
        isWord ? 'mtx-key--word' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key.cell)}
      label={key.main.replace('\n', ' ') || 'SPACE'}
      onDown={() => props.keyboard.onDown(key.cell)}
      onUp={() => props.keyboard.onUp(key.cell)}
    >
      <Show when={key.shift}>
        <span class="mtx-key__shift">{key.shift}</span>
      </Show>
      <span class="mtx-key__main">
        <For each={lines()}>{(line) => <span>{line}</span>}</For>
      </span>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const keyboard = useMtxKeyboard();
  const badge = () => BADGE_NAMES[currentModel()] ?? 'MTX';
  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <KeyboardScene
        width={MTX_SCENE.width}
        height={MTX_SCENE.height}
        unit={MTX_SCENE.unit}
        class="mtx-keyboard"
        frameClass="mtx-keyboard-frame"
        label={`Memotech ${badge()} keyboard`}
      >
        <SceneElement box={MTX_BADGE} class="mtx-badge">
          <span class="mtx-badge__brand">MEMOTECH</span>
          <i class="mtx-badge__rule" />
          <span class="mtx-badge__model">{badge()}</span>
          <i class="mtx-badge__rule mtx-badge__rule--tail" />
        </SceneElement>
        <For each={placeMtxKeys()}>
          {(placed) => <MtxKey placed={placed} keyboard={keyboard} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
