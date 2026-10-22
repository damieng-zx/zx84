/**
 * Skeuomorphic Atari XL keyboards: dark sculpted caps in a dark bezel set into
 * the beige case, with the flat aluminium console keys down the right on the
 * 600XL/800XL and along the top on the 1200XL (see xl-geometry.ts).
 */

import { For, Match, Show, Switch } from 'solid-js';
import {
  KeyboardScene,
  SceneElement,
  SceneKey,
} from '@/ui/components/KeyboardScene.tsx';
import { useAtariKeyboard, type AtariKeyboardController } from './keyboard-common.tsx';
import {
  ATARI_XL_FACES,
  type AtariXlCaseMark,
  type AtariXlVariant,
  type PlacedAtariXlKey,
} from './xl-geometry.ts';

/** The inverse-video legend: a box with its lower-right half filled. */
function InverseGlyph() {
  return (
    <svg class="atarixl-key__glyph" viewBox="0 0 20 14" aria-hidden="true">
      <rect x="1" y="1" width="18" height="12" fill="none" stroke="currentColor" stroke-width="1.6" />
      <path d="M19 1v12H1z" fill="currentColor" />
    </svg>
  );
}

const LABELS: Readonly<Record<string, string>> = {
  space: 'SPACE',
  inverse: 'Inverse video',
  'strip-inverse': 'Inverse video',
};

function XlKey(props: { placed: PlacedAtariXlKey; keyboard: AtariKeyboardController }) {
  const key = props.placed.key;
  const inverse = key.id === 'inverse' || key.id === 'strip-inverse';
  return (
    <SceneKey
      box={props.placed.box}
      class={[
        'atarixl-key',
        `atarixl-key--${key.tone}`,
        `atarixl-key--${key.id}`,
        key.shift ? 'atarixl-key--shifted' : '',
        key.aux ? 'atarixl-key--boxed' : '',
        key.main.length > 1 ? 'atarixl-key--word' : '',
      ].filter(Boolean).join(' ')}
      pressed={props.keyboard.isDown(key.action)}
      label={LABELS[key.id] ?? key.main}
      onDown={() => props.keyboard.onDown(key.action)}
      onUp={() => props.keyboard.onUp(key.action)}
    >
      {/* The flat keys are named on the case, not on the key. */}
      <Show when={key.tone === 'cap'}>
        <Show when={key.aux || key.shift}>
          <span class="atarixl-key__top">
            <Show when={key.aux}><span class="atarixl-key__aux">{key.aux}</span></Show>
            <Show when={key.shift}><span class="atarixl-key__shift">{key.shift}</span></Show>
          </span>
        </Show>
        <span class="atarixl-key__main">
          <Show when={inverse} fallback={key.main}>
            <InverseGlyph />
          </Show>
        </span>
      </Show>
    </SceneKey>
  );
}

function CaseMark(props: { mark: AtariXlCaseMark; portB: number }) {
  // The 1200XL's L1/L2 lamps follow PORTB bits 2 and 3, lit when low.
  const lit = () => {
    switch (props.mark.lamp) {
      case 'power': return true;
      case 'l1': return (props.portB & 0x04) === 0;
      case 'l2': return (props.portB & 0x08) === 0;
      default: return false;
    }
  };
  const lamp = () => <span class={`atarixl-lamp${lit() ? ' atarixl-lamp--lit' : ''}`} />;
  return (
    <Switch>
      {/* A lamp with its legend under it, centred on the word. */}
      <Match when={props.mark.lamp && props.mark.text}>
        <SceneElement box={props.mark.box} class="atarixl-case-legend">
          <span class="atarixl-lamp-legend">{lamp()}{props.mark.text}</span>
        </SceneElement>
      </Match>
      <Match when={props.mark.lamp}>
        <SceneElement box={props.mark.box} class="atarixl-lamp-box">{lamp()}</SceneElement>
      </Match>
      <Match when={true}>
        <SceneElement box={props.mark.box} class="atarixl-case-legend">
          <Show when={props.mark.glyph === 'inverse'} fallback={props.mark.text}>
            <InverseGlyph />
          </Show>
        </SceneElement>
      </Match>
    </Switch>
  );
}

export function XlKeyboard(props: { variant: AtariXlVariant; name: string }) {
  const keyboard = useAtariKeyboard();
  const face = () => ATARI_XL_FACES[props.variant];
  return (
    <KeyboardScene
      width={face().scene.width}
      height={face().scene.height}
      unit={face().scene.unit}
      class={`atarixl-keyboard atarixl-keyboard--${props.variant}${face().fullWidth ? ' atarixl-keyboard--full-width' : ''}`}
      label={`Atari ${props.name} keyboard`}
      fill
    >
      <SceneElement box={face().bezel} class="atarixl-bezel" />
      <SceneElement box={face().strip} class="atarixl-strip" />
      <SceneElement box={face().well} class="atarixl-well" />
      <Show when={face().badge}>
        {(badge) => (
          <SceneElement box={badge()} class="atarixl-badge">
            <span class="atarixl-badge__atari">ATARI</span>
            <span class="atarixl-badge__model">1200XL</span>
          </SceneElement>
        )}
      </Show>
      <For each={face().marks}>
        {(mark) => <CaseMark mark={mark} portB={keyboard.portB()} />}
      </For>
      <For each={face().keys}>
        {(placed) => <XlKey placed={placed} keyboard={keyboard} />}
      </For>
    </KeyboardScene>
  );
}
