/**
 * Skeuomorphic BBC Micro Model B keyboard: the red function-key strip and the
 * main QWERTY deck, filling the pane's width.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { resetMachine } from '@/shell/lifecycle.ts';
import { useBbcKeyboard } from './keyboard-common.tsx';
import type { BbcKeyboardController, BbcLed } from './keyboard-common.tsx';
import { BBC_LED_BOX, BBC_SCENE, placeBbcKeys, type PlacedBbcKey } from './scene-geometry.ts';

const LEDS: readonly { id: BbcLed; label: string }[] = [
  { id: 'motor', label: 'CASSETTE MOTOR' },
  { id: 'caps', label: 'CAPS LOCK' },
  { id: 'shift', label: 'SHIFT LOCK' },
];

/** The three indicator lamps beside the space bar. */
function BbcLeds(props: { keyboard: BbcKeyboardController }) {
  return (
    <SceneElement box={BBC_LED_BOX} class="bbc-leds">
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

function BbcKey(props: { placed: PlacedBbcKey; keyboard: BbcKeyboardController }) {
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
        fill
        class="bbc-keyboard"
        label="BBC Micro Model B keyboard"
      >
        <For each={placeBbcKeys()}>
          {(placed) => <BbcKey placed={placed} keyboard={keyboard} />}
        </For>
        <BbcLeds keyboard={keyboard} />
      </KeyboardScene>
    </Pane>
  );
}
