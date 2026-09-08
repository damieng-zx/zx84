/**
 * Skeuomorphic UK Tatung Einstein keyboards: the key deck alone, without the
 * case top that carried the drive bezel and badge.
 */

import { For, Match, Show, Switch } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { currentModel } from '@/state/machine-state.ts';
import { useEinsteinKeyboard } from './keyboard-common.tsx';
import type { EinsteinKeyboardController } from './keyboard-common.tsx';
import {
  E256_CURSOR_WELL,
  E256_FUNCTION_LEGENDS,
  E256_FUNCTION_STRIP,
  E256_SCENE,
  TC01_SCENE,
  placeE256Keys,
  placeTc01Keys,
  type PlacedEinsteinKey,
} from './scene-geometry.ts';

function EinsteinKey(props: {
  placed: PlacedEinsteinKey;
  keyboard: EinsteinKeyboardController;
  prefix: string;
  /** Caps with a lamp moulded into them; it travels with the cap. */
  lamp?: () => boolean;
}) {
  const key = props.placed.key;
  const lines = () => key.main.split('\n');
  const isWord = key.main.length > 1;
  return (
    <SceneKey
      box={props.placed.box}
      hitClip={props.placed.hitClip}
      class={[
        `${props.prefix}-key`,
        `${props.prefix}-key--${key.tone}`,
        `${props.prefix}-key--${key.region}`,
        `${props.prefix}-key--${key.id}`,
        key.shift ? `${props.prefix}-key--shifted` : '',
        isWord ? `${props.prefix}-key--word` : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key.chord)}
      label={key.main.replace('\n', ' ') || 'SPACE'}
      onDown={() => props.keyboard.onDown(key.chord)}
      onUp={() => props.keyboard.onUp(key.chord)}
    >
      <Show when={props.lamp}>
        <i class={`${props.prefix}-key__lamp`} classList={{ lit: props.lamp?.() }} />
      </Show>
      <Show when={key.shift}>
        <span class={`${props.prefix}-key__shift`}>{key.shift}</span>
      </Show>
      <span class={`${props.prefix}-key__main`}>
        <For each={lines()}>{(line) => <span>{line}</span>}</For>
      </span>
    </SceneKey>
  );
}

function Tc01Keyboard() {
  const keyboard = useEinsteinKeyboard();
  return (
    <KeyboardScene
      width={TC01_SCENE.width}
      height={TC01_SCENE.height}
      unit={TC01_SCENE.unit}
      class="tc01-keyboard"
      label="Tatung Einstein TC-01 keyboard"
    >
      <For each={placeTc01Keys()}>
        {(placed) => (
          <EinsteinKey placed={placed} keyboard={keyboard} prefix="tc01" />
        )}
      </For>
    </KeyboardScene>
  );
}

function E256Keyboard() {
  const keyboard = useEinsteinKeyboard();
  return (
    <KeyboardScene
      width={E256_SCENE.width}
      height={E256_SCENE.height}
      unit={E256_SCENE.unit}
      class="e256-keyboard"
      label="Tatung Einstein 256 keyboard"
    >
      {/* The printed card above the function keys, under its clear holder. */}
      <SceneElement box={E256_FUNCTION_STRIP} class="e256-legend-card">
        <For each={E256_FUNCTION_LEGENDS}>
          {([upper, lower]) => (
            <span class="e256-legend-cell">
              <span>{upper}</span>
              <span>{lower}</span>
            </span>
          )}
        </For>
      </SceneElement>
      <SceneElement box={E256_CURSOR_WELL} class="e256-cursor-well" />

      <For each={placeE256Keys()}>
        {(placed) => (
          <EinsteinKey
            placed={placed}
            keyboard={keyboard}
            prefix="e256"
            lamp={placed.key.id === 'alpha-lock' ? keyboard.alphaLock : undefined}
          />
        )}
      </For>
    </KeyboardScene>
  );
}

export function KeyboardPane() {
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <Switch fallback={<Tc01Keyboard />}>
        <Match when={currentModel() === 'einstein-256'}>
          <E256Keyboard />
        </Match>
      </Switch>
    </Pane>
  );
}
