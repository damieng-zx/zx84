/**
 * The Atari keyboard pane, showing the running model's face: the 400's flat
 * membrane deck with its raised key ridges and the console column (SYSTEM
 * RESET, OPTION, SELECT, START) beside it, which also stands in for the 800,
 * or one of the XL faces in XlKeyboard.tsx.
 */

import { For, Match, Show, Switch } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import {
  KeyboardScene,
  SceneElement,
  SceneKey,
} from '@/ui/components/KeyboardScene.tsx';
import { currentModel } from '@/state/machine-state.ts';
import { atariModelName, isAtariModel } from '@/machines/atari/models.ts';
import { useAtariKeyboard } from './keyboard-common.tsx';
import { XlKeyboard } from './XlKeyboard.tsx';
import {
  ATARI400_CONSOLE,
  ATARI400_DECK,
  ATARI400_POWER_LAMP,
  ATARI400_POWER_LEGEND,
  ATARI400_SCENE,
  placeAtari400Keys,
  type PlacedAtari400Key,
} from './scene-geometry.ts';

/** The Atari "Fuji" logo printed on the inverse-video key. */
function FujiLogo() {
  return (
    <svg class="atari400-key__logo" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.4 2h3.2v20h-3.2z" />
      <path d="M8.6 2h-2.8c0 9-1 15-5.8 20h3.6c4-3.6 5-10 5-20z" />
      <path d="M15.4 2h2.8c0 9 1 15 5.8 20h-3.6c-4-3.6-5-10-5-20z" />
    </svg>
  );
}

const LABELS: Readonly<Record<string, string>> = {
  space: 'SPACE',
  inverse: 'Inverse video',
};

function Atari400Key(props: {
  placed: PlacedAtari400Key;
  keyboard: ReturnType<typeof useAtariKeyboard>;
}) {
  const key = props.placed.key;
  const isWord = key.main.length > 1;
  return (
    <SceneKey
      box={props.placed.box}
      class={[
        'atari400-key',
        `atari400-key--${key.tone}`,
        `atari400-key--${key.id}`,
        key.shift ? 'atari400-key--shifted' : '',
        isWord ? 'atari400-key--word' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key.action)}
      label={LABELS[key.id] ?? key.main}
      onDown={() => props.keyboard.onDown(key.action)}
      onUp={() => props.keyboard.onUp(key.action)}
    >
      <Show when={key.shift}>
        <span class="atari400-key__shift">{key.shift}</span>
      </Show>
      <Show when={key.aux}>
        <span class="atari400-key__aux">{key.aux}</span>
      </Show>
      <Show when={key.id === 'inverse'} fallback={<span class="atari400-key__main">{key.main}</span>}>
        <span class="atari400-key__main"><FujiLogo /></span>
      </Show>
    </SceneKey>
  );
}

function Atari400Keyboard() {
  const keyboard = useAtariKeyboard();
  return (
    <KeyboardScene
      width={ATARI400_SCENE.width}
      height={ATARI400_SCENE.height}
      unit={ATARI400_SCENE.unit}
      class="atari400-keyboard"
      label="Atari 400 keyboard"
    >
      <SceneElement box={ATARI400_DECK} class="atari400-deck" />
      <SceneElement box={ATARI400_CONSOLE} class="atari400-deck atari400-deck--console" />
      <SceneElement box={ATARI400_POWER_LAMP} class="atari400-lamp" />
      <SceneElement box={ATARI400_POWER_LEGEND} class="atari400-case-legend">
        POWER
      </SceneElement>

      <For each={placeAtari400Keys()}>
        {(placed) => <Atari400Key placed={placed} keyboard={keyboard} />}
      </For>
    </KeyboardScene>
  );
}

export function KeyboardPane() {
  const model = () => {
    const current = currentModel();
    return isAtariModel(current) ? current : 'atari400';
  };
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <Switch fallback={<Atari400Keyboard />}>
        <Match when={model() !== 'atari400' && model() !== 'atari800' && model() !== 'atari1200xl'}>
          <XlKeyboard variant="xl" name={atariModelName(model())} />
        </Match>
        <Match when={model() === 'atari1200xl'}>
          <XlKeyboard variant="1200xl" name="1200XL" />
        </Match>
      </Switch>
    </Pane>
  );
}
