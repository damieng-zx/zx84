/**
 * Skeuomorphic Camputers Lynx keyboard: the CAMPUTERS LYNX badge, the stepped
 * key deck and the space bar in the case front. The 48K, 96K and 128K share
 * all of it, so nothing here varies by model.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { useLynxKeyboard } from './keyboard-common.tsx';
import type { LynxKeyboardController } from './keyboard-common.tsx';
import {
  LYNX_BADGE,
  LYNX_SCENE,
  LYNX_WELLS,
  placeLynxKeys,
  type PlacedLynxKey,
} from './scene-geometry.ts';

/** The five squares scattered down the right of the badge, measured off the
 *  plate as `[tone, left%, top%, width%]`. Each is square — the CSS holds the
 *  aspect — so only the width is given. */
const BADGE_TILES: readonly (readonly [string, number, number, number])[] = [
  ['amber', 71.0, 38.2, 4.4],
  ['salmon', 76.7, 35.3, 4.4],
  ['green', 82.4, 45.4, 4.7],
  ['red', 66.6, 54.0, 4.7],
  ['blue', 72.0, 59.1, 9.1],
];

function LynxKey(props: { placed: PlacedLynxKey; keyboard: LynxKeyboardController }) {
  const key = props.placed.key;
  const lines = () => key.main.split('\n');
  return (
    <SceneKey
      box={props.placed.box}
      class={[
        'lynx-key',
        `lynx-key--${key.region}`,
        `lynx-key--${key.id}`,
        key.shift ? 'lynx-key--shifted' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key.id, key.cell)}
      label={key.main.replace('\n', ' ') || 'SPACE'}
      onDown={() => props.keyboard.onDown(key.id, key.cell)}
      onUp={() => props.keyboard.onUp(key.id, key.cell)}
    >
      <Show when={key.shift}>
        <span class="lynx-key__shift">{key.shift}</span>
      </Show>
      <span class="lynx-key__main">
        <For each={lines()}>{(line) => <span>{line}</span>}</For>
      </span>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const keyboard = useLynxKeyboard();
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={LYNX_SCENE.width}
        height={LYNX_SCENE.height}
        unit={LYNX_SCENE.unit}
        class="lynx-keyboard"
        label="Camputers Lynx keyboard"
      >
        <SceneElement box={LYNX_BADGE} class="lynx-badge">
          <span class="lynx-badge__brand">CAMPUTERS</span>
          <i class="lynx-badge__rule" />
          <span class="lynx-badge__model">LYNX</span>
          <For each={BADGE_TILES}>
            {([tone, left, top, width]) => (
              <i
                class={`lynx-badge__tile lynx-badge__tile--${tone}`}
                style={{ left: `${left}%`, top: `${top}%`, width: `${width}%` }}
              />
            )}
          </For>
        </SceneElement>
        <For each={LYNX_WELLS}>
          {(box) => <SceneElement box={box} class="lynx-well" />}
        </For>
        <For each={placeLynxKeys()}>
          {(placed) => <LynxKey placed={placed} keyboard={keyboard} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
