/**
 * Skeuomorphic UK Toshiba HX-10P keyboard: the key deck alone, without the
 * case top that carried the branding, vents and cartridge slot.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import {
  KeyboardScene,
  SceneElement,
  SceneKey,
} from '@/ui/components/KeyboardScene.tsx';
import { useHx10Keyboard } from './keyboard-common.tsx';
import {
  HX10_SCENE,
  placeHx10Keys,
  type PlacedHx10Key,
} from './scene-geometry.ts';

function Hx10Key(props: {
  placed: PlacedHx10Key;
  keyboard: ReturnType<typeof useHx10Keyboard>;
}) {
  const key = props.placed.key;
  const isWord = key.main.length > 1;
  return (
    <SceneKey
      box={props.placed.box}
      hitClip={props.placed.hitClip}
      class={[
        'hx10-key',
        `hx10-key--${key.tone}`,
        `hx10-key--${key.region}`,
        `hx10-key--${key.id}`,
        key.shift ? 'hx10-key--shifted' : '',
        key.aux ? 'hx10-key--dual-function' : '',
        isWord ? 'hx10-key--word' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key.cell)}
      label={key.main || 'SPACE'}
      onDown={() => props.keyboard.onDown(key.cell)}
      onUp={() => props.keyboard.onUp(key.cell)}
    >
      <Show when={key.shift}>
        <span class="hx10-key__shift">{key.shift}</span>
      </Show>
      <Show when={key.aux}>
        <span class="hx10-key__aux">{key.aux}</span>
      </Show>
      <span class="hx10-key__main">{key.main}</span>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const keyboard = useHx10Keyboard();
  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <KeyboardScene
        width={HX10_SCENE.width}
        height={HX10_SCENE.height}
        unit={HX10_SCENE.unit}
        class="hx10-keyboard"
        label="Toshiba HX-10 keyboard"
      >
        <SceneElement
          box={{ x: 28, y: 26, width: 12, height: 12 }}
          class="hx10-lamp hx10-lamp--power"
        />
        <SceneElement
          box={{ x: 80, y: 238, width: 12, height: 12 }}
          class="hx10-lamp hx10-lamp--caps"
        />

        <For each={placeHx10Keys()}>
          {(placed) => <Hx10Key placed={placed} keyboard={keyboard} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
