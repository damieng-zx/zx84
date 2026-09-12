/**
 * Skeuomorphic Amstrad PCW keyboard: the AMSTRAD plate on the case, the
 * charcoal deck, and the 82 cream caps in their 19-column grid.
 *
 * Only the badge varies by model — it names the machine's memory, which is how
 * an 8256 deck and an 8512 deck are told apart at a glance. The 9512's own deck
 * is a different, XT-style arrangement that is not traced; see `layout.ts`.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { currentModel } from '@/state/machine-state.ts';
import { usePcwKeyboard, type PcwKeyboardController } from './keyboard-common.tsx';
import {
  PCW_BADGE, PCW_SCENE, PCW_WELL, placePcwKeys, type PlacedPcwKey,
} from './scene-geometry.ts';

/** What the badge says before "Personal Computer Word Processor". */
function badgeSize(model: string): string {
  return model === 'pcw8512' || model === 'pcw9512' ? '512k' : '256k';
}

function PcwKey(props: { placed: PlacedPcwKey; keyboard: PcwKeyboardController }) {
  const key = props.placed.key;
  const lines = () => key.main.split('\n');
  const fnLines = () => (key.fn ?? '').split('\n');
  return (
    <SceneKey
      box={props.placed.box}
      hitClip={props.placed.hitClip}
      class={[
        'pcw-key',
        `pcw-key--${key.region}`,
        `pcw-key--${key.id}`,
        key.shift ? 'pcw-key--shifted' : '',
        key.fn ? 'pcw-key--labelled' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key.id, key.cell)}
      label={(key.fn ? `${key.fn.replace('\n', ' ')} ` : '')
        + (key.main.replace('\n', ' ') || 'SPACE')}
      onDown={() => props.keyboard.onDown(key.cell)}
      onUp={() => props.keyboard.onUp(key.cell)}
    >
      <Show when={key.shift}>
        <span class="pcw-key__shift">{key.shift}</span>
      </Show>
      <Show when={key.fn}>
        <span class="pcw-key__fn">
          <For each={fnLines()}>{(line) => <span>{line}</span>}</For>
        </span>
      </Show>
      <span class="pcw-key__main">
        <For each={lines()}>{(line) => <span>{line}</span>}</For>
      </span>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const keyboard = usePcwKeyboard();
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={PCW_SCENE.width}
        height={PCW_SCENE.height}
        unit={PCW_SCENE.unit}
        class="pcw-keyboard"
        label="Amstrad PCW keyboard"
      >
        <SceneElement box={PCW_BADGE} class="pcw-badge">
          <span class="pcw-badge__brand">AMSTRAD</span>
          <span class="pcw-badge__model">
            <b>{badgeSize(currentModel())}</b> Personal Computer Word Processor
          </span>
        </SceneElement>
        <SceneElement box={PCW_WELL} class="pcw-well" />
        <For each={placePcwKeys()}>
          {(placed) => <PcwKey placed={placed} keyboard={keyboard} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
