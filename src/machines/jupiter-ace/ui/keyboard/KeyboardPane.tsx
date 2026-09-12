/**
 * Jupiter Ace on-screen keyboard.
 *
 * The Spectrum 48K's rubber-key layout on the Ace's own case: white plastic,
 * very dark brown moulded-rubber keys with white characters. Each cap prints
 * its glyph bottom-left and its SYMBOL SHIFT character top-right, and the digit
 * keys add their GRAPHICS block swatch bottom-right; their SHIFT functions
 * (DELETE LINE, cursor arrows…) are printed on the case below them (see
 * `legends.ts`). Drives the live `AceKeyboard` matrix and
 * highlights from it — see `useKeyboard()`.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { ACE_ROWS, type Graphic } from './legends.ts';
import { useKeyboard, type KeyboardController } from './keyboard-common.tsx';
import { ACE_SCENE, placeAceRows, type PlacedAceKey } from './scene-geometry.ts';

const ARROW = /^[←↑↓→]$/;

// Quadrant origins in the swatch's 2×2 grid: TL, TR, BL, BR.
const QUADS: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [0, 1], [1, 1]];

/** A 2×2 block-graphics swatch drawn as crisp SVG; lit quadrants fill. */
function Block(props: { g: Graphic }) {
  return (
    <svg class="acek-block" viewBox="0 0 2 2" shape-rendering="crispEdges" aria-hidden="true">
      <For each={QUADS.filter((_, i) => props.g[i])}>
        {([x, y]) => <rect x={x} y={y} width={1} height={1} />}
      </For>
    </svg>
  );
}

function AceKeyCap(props: { placed: PlacedAceKey; kbd: KeyboardController }) {
  const k = props.placed.key;
  return (
    <>
      {/* SHIFT function, printed on the case below the digit keys. */}
      <Show when={props.placed.below && k.shiftFn ? props.placed.below : null}>
        {(box) => (
          <SceneElement
            box={box()}
            class={`acek-below${ARROW.test(k.shiftFn!) ? ' acek-below--arrow' : ''}`}
          >
            {k.shiftFn}
          </SceneElement>
        )}
      </Show>

      <SceneKey
        box={props.placed.cap}
        class={`acek-key acek-key--${k.kind}`}
        pressed={props.kbd.isDown(k.pos)}
        label={k.main.replace('\n', ' ')}
        onDown={() => props.kbd.onDown(k.pos, k.latch)}
        onUp={() => props.kbd.onUp(k.pos, k.latch)}
      >
        <Show
          when={k.kind !== 'special'}
          fallback={
            <span class="acek-special" classList={{ 'acek-special--biglast': k.bigLast }}>
              <For each={k.main.split('\n')}>{(line) => <span>{line}</span>}</For>
            </span>
          }
        >
          <span class="acek-main">{k.main}</span>
          <Show when={k.symbol}><span class="acek-sym">{k.symbol}</span></Show>
          <Show when={k.graphic}>{(g) => <Block g={g()} />}</Show>
        </Show>
      </SceneKey>
    </>
  );
}

export function KeyboardPane() {
  const kbd = useKeyboard();
  const keys = placeAceRows(ACE_ROWS);
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={ACE_SCENE.width}
        height={ACE_SCENE.height}
        unit={ACE_SCENE.unit}
        fill
        class="acek-bezel"
        label="Jupiter Ace keyboard"
      >
        <For each={keys}>{(placed) => <AceKeyCap placed={placed} kbd={kbd} />}</For>
      </KeyboardScene>
    </Pane>
  );
}
