/**
 * Skeuomorphic UK Toshiba HX-10P keyboard.
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
        <SceneElement box={{ x: 18, y: 137, width: 824, height: 268 }} class="hx10-deck" />

        <SceneElement box={{ x: 34, y: 13, width: 430, height: 28 }} class="hx10-brand">
          <strong>TOSHIBA</strong>
          <span>HOME COMPUTER HX-10</span>
          <em>64K</em>
        </SceneElement>
        <SceneElement box={{ x: 34, y: 48, width: 440, height: 76 }} class="hx10-vents">
          <i />
        </SceneElement>
        <SceneElement box={{ x: 515, y: 44, width: 280, height: 82 }} class="hx10-cartridge">
          <i />
          <span>CARTRIDGE<br />SLOT</span>
        </SceneElement>

        <SceneElement box={{ x: 54, y: 154, width: 34, height: 34 }} class="hx10-power">
          <span>POWER</span>
          <i />
        </SceneElement>
        <SceneElement box={{ x: 105, y: 370, width: 20, height: 20 }} class="hx10-caps-led">
          <i />
        </SceneElement>
        <SceneElement box={{ x: 704, y: 280, width: 22, height: 22 }} class="hx10-cursor-dimple">
          <i />
        </SceneElement>
        <SceneElement box={{ x: 690, y: 410, width: 136, height: 23 }} class="hx10-msx-badge">
          <i />
          <strong>MSX</strong>
          <i />
        </SceneElement>

        <For each={placeHx10Keys()}>
          {(placed) => <Hx10Key placed={placed} keyboard={keyboard} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
