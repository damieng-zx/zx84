/**
 * Skeuomorphic MGT SAM Coupé keyboard.
 *
 * The cream case with its two cap tones, the MGT badge, and the SAM Coupé logo
 * on the palm rest — laid out from a photograph of a real machine (see
 * `scene-geometry.ts`). Every cap drives the live matrix and highlights from
 * it, so physical typing lights the same keys.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { useSamKeyboard, type SamKeyboardController } from './keyboard-common.tsx';
import { placeSamKeys, SAM_SCENE, type PlacedSamKey } from './scene-geometry.ts';

/** A word legend (SHIFT, DELETE) sets smaller than a single character. */
const isWord = (main: string) => main.length > 1;

function SamKey(props: { placed: PlacedSamKey; keyboard: SamKeyboardController }) {
  const key = props.placed.key;
  return (
    <SceneKey
      box={props.placed.box}
      hitClip={props.placed.hitClip}
      class={[
        'sam-key',
        key.dark ? 'sam-key--dark' : '',
        isWord(key.main) ? 'sam-key--word' : '',
        `sam-key--${key.id}`,
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key.cell)}
      label={key.main || 'SPACE'}
      onDown={() => props.keyboard.onDown(key.cell)}
      onUp={() => props.keyboard.onUp(key.cell)}
    >
      <Show when={key.top}>
        <span class="sam-key__top">{key.top}</span>
      </Show>
      <span class="sam-key__main">{key.main}</span>
    </SceneKey>
  );
}

export function KeyboardPane() {
  const keyboard = useSamKeyboard();
  const keys = placeSamKeys();
  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <KeyboardScene
        width={SAM_SCENE.width}
        height={SAM_SCENE.height}
        unit={SAM_SCENE.unit}
        class="sam-keyboard"
        label="MGT SAM Coupé keyboard"
      >
        <For each={keys}>
          {placed => <SamKey placed={placed} keyboard={keyboard} />}
        </For>
        <SceneElement box={{ x: SAM_SCENE.width - 96, y: 4, width: 80, height: 12 }} class="sam-badge">
          MGT
        </SceneElement>
      </KeyboardScene>
    </Pane>
  );
}
