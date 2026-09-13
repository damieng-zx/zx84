/**
 * Skeuomorphic Amstrad PCW keyboard: the AMSTRAD plate on the case, the
 * charcoal wells, and the 82 cream caps.
 *
 * Which deck is drawn follows the model. The 8256 and 8512 share one slab of
 * 19 columns; the 9512 and 9256 were redesigned into three blocks, with the
 * function keys down the left and the pad off on its own to the right. The
 * plate differs too: it names the machine's memory on both, and the 9000s add
 * the model number in red at the far end.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { currentModel } from '@/state/machine-state.ts';
import type { MachineModel } from '@/models.ts';
import { isPcwModel, pcwHasNineSeriesDeck } from '@/machines/pcw/models.ts';
import { usePcwKeyboard, type PcwKeyboardController } from './keyboard-common.tsx';
import type { PcwKeyDef } from './layout.ts';
import {
  PCW8_FACE, pcw9Face, type PcwFace, type PlacedPcwKey,
} from './scene-geometry.ts';

/** What the plate says before "Personal Computer Word Processor". */
function badgeSize(model: MachineModel): string {
  return model === 'pcw8512' || model === 'pcw9512' ? '512k' : '256k';
}

/** The 9000s' plate carries the bare model number, in red, at its far end. */
function pcwFace(model: MachineModel): PcwFace {
  return isPcwModel(model) && pcwHasNineSeriesDeck(model)
    ? pcw9Face(model.replace('pcw', ''))
    : PCW8_FACE;
}

/** What a screen reader reads out: the word-processing legend, then the cap. */
function capLabel(key: PcwKeyDef): string {
  const fn = key.fn ? `${key.fn.replace('\n', ' ')} ` : '';
  return fn + (key.main.replace('\n', ' ') || 'SPACE');
}

function PcwKey(props: { placed: PlacedPcwKey; keyboard: PcwKeyboardController }) {
  const key = () => props.placed.key;
  const lines = () => key().main.split('\n');
  const fnLines = () => (key().fn ?? '').split('\n');
  return (
    <SceneKey
      box={props.placed.box}
      hitClip={props.placed.hitClip}
      class={[
        'pcw-key',
        `pcw-key--${key().region}`,
        `pcw-key--${key().id}`,
        key().shift ? 'pcw-key--shifted' : '',
        key().fn ? 'pcw-key--labelled' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key().id, key().cell)}
      label={capLabel(key())}
      onDown={() => props.keyboard.onDown(key().cell)}
      onUp={() => props.keyboard.onUp(key().cell)}
    >
      <Show when={key().shift}>
        <span class="pcw-key__shift">{key().shift}</span>
      </Show>
      <Show when={key().fn}>
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
  const face = () => pcwFace(currentModel());
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={face().scene.width}
        height={face().scene.height}
        unit={face().scene.unit}
        class={`pcw-keyboard pcw-keyboard--${face().deck}`}
        label="Amstrad PCW keyboard"
      >
        <SceneElement box={face().badge} class={`pcw-badge pcw-badge--${face().deck}`}>
          <span class="pcw-badge__brand">AMSTRAD</span>
          <span class="pcw-badge__model">
            <b>{badgeSize(currentModel())}</b> Personal Computer Word Processor
          </span>
          <Show when={face().plateModel}>
            {(number) => (
              <span class="pcw-badge__plate"><b>PCW</b>{number()}</span>
            )}
          </Show>
        </SceneElement>
        <For each={face().wells}>
          {(well) => <SceneElement box={well} class="pcw-well" />}
        </For>
        <For each={face().keys}>
          {(placed) => <PcwKey placed={placed} keyboard={keyboard} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
