/**
 * Skeuomorphic Apple II keyboards: the ][/][+'s dark caps on the beige case,
 * the //e's grey caps, and the //c's light caps with its top strip of switches.
 */

import { For, Index, Match, Show, Switch } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { currentModel } from '@/state/machine-state.ts';
import { useApple2Keyboard, type Apple2KeyboardController } from './keyboard-common.tsx';
import { apple2KeyboardVariant, apple2Keys, type Apple2KeyboardVariant } from './layout.ts';
import {
  APPLE2_POWER_LAMP,
  APPLE2C_LAMPS,
  APPLE2C_SWITCHES,
  APPLE2E_POWER_LAMP,
  apple2Scene,
  placeApple2Keys,
  type PlacedApple2Key,
} from './scene-geometry.ts';

const LABELS: Record<Apple2KeyboardVariant, string> = {
  apple2: 'Apple ][ keyboard',
  apple2e: 'Apple //e keyboard',
  apple2c: 'Apple //c keyboard',
};

/** The Apple keys' logo: outlined on Open-Apple, filled on Solid-Apple. */
function AppleLogo(props: { solid: boolean }) {
  return (
    <svg class="a2-key__logo" viewBox="0 0 20 24" aria-hidden="true">
      <path
        d="M10 7.2C8.3 5.9 5.4 5.7 3.7 7.6 1.6 10 2 14.8 4.3 18.6c1.3 2.1 2.7 3.6 4.3 3.2.8-.2 1.1-.6 1.4-.6s.6.4 1.4.6c1.6.4 3-1.1 4.3-3.2.9-1.4 1.5-2.7 1.8-3.8-1.9-.9-3-2.6-3-4.6 0-1.6.8-3 2-3.8-1.6-1.9-4.6-1.6-6.5-.2z"
        fill={props.solid ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linejoin="round"
      />
      <path
        d="M10 6.2c0-2.2 1.6-4.4 4-5 .2 2.4-1.6 4.6-4 5z"
        fill={props.solid ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function Apple2Key(props: { placed: PlacedApple2Key; keyboard: Apple2KeyboardController }) {
  const key = props.placed.key;
  const lines = key.main.split('\n');
  return (
    <SceneKey
      box={props.placed.box}
      class={[
        'a2-key',
        `a2-key--${key.region}`,
        `a2-key--${key.id}`,
        key.shift ? 'a2-key--shifted' : '',
        key.aux ? 'a2-key--aux' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key)}
      label={key.main.replace('\n', ' ') || 'SPACE'}
      onDown={() => props.keyboard.onDown(key)}
      onUp={() => props.keyboard.onUp(key)}
    >
      <Switch>
        <Match when={key.region === 'apple'}>
          <AppleLogo solid={key.action === 'solid-apple'} />
        </Match>
        <Match when={key.region !== 'space'}>
          <span class="a2-key__legend">
            <Show when={key.shift}>
              <span class="a2-key__shift">{key.shift}</span>
            </Show>
            <Index each={lines}>{(line) => <span class="a2-key__main">{line()}</span>}</Index>
            <Show when={key.aux}>
              <span class="a2-key__aux">{key.aux}</span>
            </Show>
          </span>
        </Match>
      </Switch>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const variant = () => apple2KeyboardVariant(currentModel());
  const keyboard = useApple2Keyboard(variant, () => apple2Keys(variant()));
  const scene = () => apple2Scene(variant());
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={scene().width}
        height={scene().height}
        unit={scene().unit}
        class={`a2-keyboard a2-keyboard--${variant()}`}
        label={LABELS[variant()]}
      >
        <Switch>
          <Match when={variant() === 'apple2'}>
            <SceneElement box={APPLE2_POWER_LAMP} class="a2-lamp a2-lamp--lens">
              <span>POWER</span>
            </SceneElement>
          </Match>
          <Match when={variant() === 'apple2e'}>
            <SceneElement box={APPLE2E_POWER_LAMP} class="a2-lamp a2-lamp--lens" />
          </Match>
          <Match when={variant() === 'apple2c'}>
            <For each={APPLE2C_SWITCHES}>
              {(item) => (
                <SceneElement box={item.box} class="a2-switch">
                  <span>{item.label}</span>
                </SceneElement>
              )}
            </For>
            <For each={APPLE2C_LAMPS}>
              {(item) => (
                <SceneElement box={item.box} class={`a2-led a2-led--${item.kind}`}>
                  <span>{item.label}</span>
                </SceneElement>
              )}
            </For>
          </Match>
        </Switch>

        <For each={placeApple2Keys(variant())}>
          {(placed) => <Apple2Key placed={placed} keyboard={keyboard} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
