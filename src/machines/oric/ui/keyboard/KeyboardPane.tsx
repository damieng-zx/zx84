/**
 * The Oric keyboard, on screen.
 *
 * The two machines share a key matrix and the same physical arrangement of caps,
 * but look nothing alike, so the pane renders one of two decks:
 *
 *  - **Atmos**: charcoal case, black character caps carrying their legends, and
 *    every control cap (ESC/CTRL/SHIFT/DEL/RETURN/arrows/FUNCT) in orange.
 *  - **Oric-1**: cream case, *blank* cream chiclet caps, and all the legends
 *    silkscreened in white on the black plate above each key. It has no FUNCT.
 *
 * The layout *data* is shared; the two decks differ in appearance, in the cap
 * height (the Oric-1's caps are shorter so the plate has room to write on), and
 * in the FUNCT cap.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { useOricKeyboard } from './keyboard-common.tsx';
import type { OricKeyboardController } from './keyboard-common.tsx';
import { isFunctCap, modelHasFunctKey } from './layout.ts';
import { atmosDeck, oric1Deck, type PlacedOricKey } from './scene-geometry.ts';

function OricKey(props: { placed: PlacedOricKey; keyboard: OricKeyboardController }) {
  const key = props.placed.key;
  const lines = (): string[] => key.main.split('\n');
  return (
    <SceneKey
      box={props.placed.box}
      class={[
        'oric-key',
        `oric-key--${key.region}`,
        `oric-key--${key.id}`,
        key.control ? 'oric-key--control' : '',
        key.shift ? 'oric-key--shifted' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key)}
      label={key.main.replace('\n', ' ') || 'SPACE'}
      onDown={() => props.keyboard.onDown(key)}
      onUp={() => props.keyboard.onUp(key)}
    >
      <Show when={key.region !== 'space'}>
        <span class="oric-key__legend">
          <Show when={key.shift}>
            <span class="oric-key__shift">{key.shift}</span>
          </Show>
          <span class="oric-key__main">
            <For each={lines()}>{(line) => <span>{line}</span>}</For>
          </span>
        </span>
      </Show>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const keyboard = useOricKeyboard();
  const showFunct = modelHasFunctKey();
  const deck = showFunct ? atmosDeck() : oric1Deck();
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={deck.scene.width}
        height={deck.scene.height}
        class={showFunct ? 'oric-keyboard oric-keyboard--atmos' : 'oric-keyboard oric-keyboard--oric1'}
        label={showFunct ? 'Oric Atmos keyboard' : 'Oric-1 keyboard'}
      >
        <SceneElement box={deck.plate} class="oric-plate" />
        <For each={deck.keys}>
          {(placed) => (
            <Show when={showFunct || !isFunctCap(placed.key)}>
              <OricKey placed={placed} keyboard={keyboard} />
            </Show>
          )}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
