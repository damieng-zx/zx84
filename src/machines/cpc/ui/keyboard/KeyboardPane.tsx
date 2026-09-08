/**
 * Skeuomorphic UK Amstrad CPC keyboards.
 */

import { For, Match, Show, Switch } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { currentModel } from '@/state/machine-state.ts';
import { useCpcKeyboard } from './keyboard-common.tsx';
import {
  CPC464_SCENE,
  CPC664_SCENE,
  CPC6128_SCENE,
  placeCpc464Keys,
  placeCpc664Keys,
  placeCpc6128Keys,
} from './scene-geometry.ts';
import type { PlacedCpcKey } from './scene-geometry.ts';
import type { CpcKeyboardController } from './keyboard-common.tsx';
import {
  cpcKeyMain,
  cpcKeyShift,
  isCpc664BlueKey,
  type CpcKeyboardVariant,
} from './variants.ts';

function CpcKey(props: {
  placed: PlacedCpcKey;
  keyboard: CpcKeyboardController;
  variant: CpcKeyboardVariant;
}) {
  const key = props.placed.key;
  const main = () => cpcKeyMain(key, props.variant);
  const shift = () => cpcKeyShift(key, props.variant);
  // Keypad caps print the function legend alone, with only the f italicised.
  const fkey = () => main() === key.fn;
  const lines = () => main().split('\n');
  return (
    <SceneKey
      box={props.placed.box}
      hitClip={props.placed.hitClip}
      class={[
        'cpc464-key',
        `cpc464-key--${key.tone ?? 'dark'}`,
        `cpc464-key--${props.placed.region}`,
        props.variant === 'cpc664' ? 'cpc664-key' : '',
        props.variant === 'cpc664' ? `cpc664-key--${key.id}` : '',
        props.variant === 'cpc664' && isCpc664BlueKey(key) ? 'cpc664-key--blue' : '',
        props.variant === 'cpc6128' ? 'cpc6128-key' : '',
        props.variant === 'cpc6128' ? `cpc6128-key--${key.id}` : '',
        key.tall ? 'cpc464-key--tall' : '',
        main().length > 2 ? 'cpc464-key--word' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key.cell)}
      label={main().replace('\n', ' ') || 'SPACE'}
      onDown={() => props.keyboard.onDown(key.cell)}
      onUp={() => props.keyboard.onUp(key.cell)}
    >
      <Show when={shift()}>
        <span class="cpc464-key__shift">{shift()}</span>
      </Show>
      <span class="cpc464-key__main">
        <Show
          when={fkey()}
          fallback={
            <For each={lines()}>{(line) => <span>{line || '\u00a0'}</span>}</For>
          }
        >
          <span><i>f</i>{main().slice(1)}</span>
        </Show>
      </span>
    </SceneKey>
  );
}

function CpcClassicKeyboard(props: { variant: CpcKeyboardVariant; name?: string }) {
  const keyboard = useCpcKeyboard();
  const is664 = () => props.variant === 'cpc664';
  const is6128 = () => props.variant === 'cpc6128';
  const modelName = () =>
    props.name ?? (props.variant === 'cpc464' ? '464'
      : props.variant === 'cpc664' ? '664' : '6128');
  const scene = () => is6128() ? CPC6128_SCENE : is664() ? CPC664_SCENE : CPC464_SCENE;
  const keys = () => is6128() ? placeCpc6128Keys() : is664() ? placeCpc664Keys() : placeCpc464Keys();
  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <KeyboardScene
        width={scene().width}
        height={scene().height}
        unit={scene().unit}
        class={[
          'cpc464-keyboard',
          is664() ? 'cpc664-keyboard' : '',
          is6128() ? 'cpc6128-keyboard' : '',
        ].filter(Boolean).join(' ')}
        label={`Amstrad CPC ${modelName()} keyboard`}
      >
        <Show
          when={is6128()}
          fallback={
            <>
              {/* Recessed badge strip: ESC's left edge (8) to DEL's right edge
                  (644.5), and the up-arrow's top down to the COPY row. */}
              <SceneElement
                box={{ x: 8, y: 25, width: 636.5, height: 38 }}
                class="cpc464-badge-panel"
              />
              <SceneElement box={{ x: 18, y: 32, width: 180, height: 27 }} class="cpc464-brand">
                AMSTRAD
              </SceneElement>
              <SceneElement box={{ x: 140, y: 47, width: 245, height: 10 }} class="cpc464-tagline">
                64K COLOUR PERSONAL COMPUTER
              </SceneElement>
              <SceneElement box={{ x: 401.5, y: 35, width: 228, height: 24 }} class="cpc464-model">
                <span>CPC {modelName()}</span>
                <i class="cpc464-colour-bars" />
                <small>COLOUR</small>
              </SceneElement>
              <SceneElement
                box={{ x: 549.5, y: 30, width: 80, height: 11 }}
                class="cpc464-power-led"
              >
                <span>ON</span>
                <i />
              </SceneElement>
            </>
          }
        >
          {/* The badge and lamp sat on removable legend plates. */}
          <SceneElement box={{ x: 4, y: 10, width: 268, height: 22 }} class="cpc6128-plate" />
          <SceneElement box={{ x: 656, y: 10, width: 72, height: 22 }} class="cpc6128-plate" />
          <SceneElement box={{ x: 8, y: 7, width: 110, height: 25 }} class="cpc464-brand">
            AMSTRAD
          </SceneElement>
          <SceneElement box={{ x: 95, y: 14, width: 300, height: 16 }} class="cpc6128-tagline">
            128K Colour Personal Computer
          </SceneElement>
          <SceneElement box={{ x: 666, y: 15.75, width: 24, height: 10.5 }} class="cpc6128-colour-bars">
            <i />
            <i />
            <i />
          </SceneElement>
          <SceneElement box={{ x: 700, y: 14, width: 24, height: 16 }} class="cpc6128-power-led">
            <span>ON</span>
            <i />
          </SceneElement>
          <SceneElement box={{ x: 0, y: 33, width: 744, height: 9 }} class="cpc6128-header-edge" />
        </Show>
        <For each={keys()}>
          {(placed) => (
            <CpcKey placed={placed} keyboard={keyboard} variant={props.variant} />
          )}
        </For>
      </KeyboardScene>
    </Pane>
  );
}

export function KeyboardPane() {
  return (
    <Switch>
      <Match when={currentModel() === 'cpc464'}>
        <CpcClassicKeyboard variant="cpc464" />
      </Match>
      <Match when={currentModel() === 'cpc664'}>
        <CpcClassicKeyboard variant="cpc664" />
      </Match>
      <Match when={currentModel() === 'cpc6128'}>
        <CpcClassicKeyboard variant="cpc6128" />
      </Match>
      {/* The Plus range kept the 6128 keyboard. */}
      <Match when={currentModel() === 'cpc6128plus'}>
        <CpcClassicKeyboard variant="cpc6128" name="6128 Plus" />
      </Match>
    </Switch>
  );
}
