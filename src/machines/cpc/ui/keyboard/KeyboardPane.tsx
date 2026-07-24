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
  const lines = () => main().split('\n');
  return (
    <SceneKey
      box={props.placed.box}
      hitClip={props.placed.hitClip}
      class={[
        'cpc464-key',
        `cpc464-key--${key.tone ?? 'dark'}`,
        `cpc464-key--${props.placed.region}`,
        `cpc664-key--${key.id}`,
        props.variant === 'cpc664' ? 'cpc664-key' : '',
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
      <Show when={key.shift}>
        <span class="cpc464-key__shift">{key.shift}</span>
      </Show>
      <Show when={key.fn}>
        <span class="cpc464-key__fn">{key.fn}</span>
      </Show>
      <span class="cpc464-key__main">
        <For each={lines()}>{(line) => <span>{line || '\u00a0'}</span>}</For>
      </span>
    </SceneKey>
  );
}

function CpcClassicKeyboard(props: { variant: CpcKeyboardVariant }) {
  const keyboard = useCpcKeyboard();
  const is664 = () => props.variant === 'cpc664';
  const is6128 = () => props.variant === 'cpc6128';
  const modelName = () => props.variant === 'cpc464' ? '464' : props.variant === 'cpc664' ? '664' : '6128';
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
              <SceneElement box={{ x: 18, y: 7, width: 180, height: 25 }} class="cpc464-brand">
                AMSTRAD
              </SceneElement>
              <Show when={is664()}>
                <SceneElement box={{ x: 112, y: 16, width: 245, height: 10 }} class="cpc664-tagline">
                  64K COLOUR PERSONAL COMPUTER
                </SceneElement>
              </Show>
              <SceneElement box={{ x: 412, y: 9, width: 228, height: 22 }} class="cpc464-model">
                <span>CPC {modelName()}</span>
                <i class="cpc464-colour-bars" />
                <small>COLOUR</small>
              </SceneElement>
              <Show when={is664()}>
                <SceneElement box={{ x: 645, y: 11, width: 18, height: 14 }} class="cpc664-leds">
                  <i />
                  <i />
                </SceneElement>
              </Show>
            </>
          }
        >
          <SceneElement box={{ x: 18, y: 7, width: 110, height: 25 }} class="cpc464-brand">
            AMSTRAD
          </SceneElement>
          <SceneElement box={{ x: 116, y: 15, width: 270, height: 12 }} class="cpc6128-tagline">
            128K COLOUR PERSONAL COMPUTER
          </SceneElement>
          <SceneElement box={{ x: 628, y: 10, width: 50, height: 14 }} class="cpc464-colour-bars" />
          <SceneElement box={{ x: 690, y: 10, width: 18, height: 14 }} class="cpc664-leds">
            <i />
            <i />
          </SceneElement>
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
    </Switch>
  );
}
