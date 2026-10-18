/**
 * Skeuomorphic Acorn Electron keyboard: five rows of keys filling the pane's
 * width, with BREAK resetting the machine like the real key.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { activeElectron } from '../active.ts';
import { useElectronKeyboard } from './keyboard-common.tsx';
import type { ElectronKeyboardController, ElectronLed } from './keyboard-common.tsx';
import {
  ELECTRON_LED_BOX, ELECTRON_SCENE, placeElectronKeys, type PlacedElectronKey,
} from './scene-geometry.ts';

const LEDS: readonly { id: ElectronLed; label: string }[] = [
  { id: 'motor', label: 'CASSETTE MOTOR' },
  { id: 'caps', label: 'CAPS LOCK' },
];

/** The two indicator lamps beside the space bar. */
function ElectronLeds(props: { keyboard: ElectronKeyboardController }) {
  return (
    <SceneElement box={ELECTRON_LED_BOX} class="bbc-leds">
      <For each={LEDS}>
        {(led) => (
          <span class="bbc-led">
            <For each={led.label.split(' ')}>{(line) => <span>{line}</span>}</For>
            <i classList={{ 'bbc-led--on': props.keyboard.ledOn(led.id) }} />
          </span>
        )}
      </For>
    </SceneElement>
  );
}

function ElectronKey(props: { placed: PlacedElectronKey; keyboard: ElectronKeyboardController }) {
  const key = props.placed.key;
  const lines = () => key.main.split('\n');
  const isWord = key.main.length > 1;
  return (
    <SceneKey
      box={props.placed.box}
      class={[
        'bbc-key',
        key.region ? `bbc-key--${key.region}` : '',
        key.shift ? 'bbc-key--shifted' : '',
        isWord ? 'bbc-key--word' : (key.shift ? '' : 'bbc-key--single'),
        key.id === 'space' ? 'bbc-key--space' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key)}
      label={key.id === 'space' ? 'SPACE' : key.main.replace('\n', ' ')}
      onDown={() => {
        if (key.id === 'break') { activeElectron()?.breakReset(); return; }
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
  const keyboard = useElectronKeyboard();
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={ELECTRON_SCENE.width}
        height={ELECTRON_SCENE.height}
        unit={1}
        fill
        class="bbc-keyboard"
        label="Acorn Electron keyboard"
      >
        <For each={placeElectronKeys()}>
          {(placed) => <ElectronKey placed={placed} keyboard={keyboard} />}
        </For>
        <ElectronLeds keyboard={keyboard} />
      </KeyboardScene>
    </Pane>
  );
}
