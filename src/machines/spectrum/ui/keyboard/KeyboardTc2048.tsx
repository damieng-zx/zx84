/**
 * The Timex Computer 2048's on-screen keyboard.
 *
 * Light grey hard keys on a black case ruled into a cell per key, traced from
 * the machine (see tc2048-keyboard.ts). It drives the same matrix as every
 * Spectrum keyboard, and highlights from it, through `useKeyboard()`.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { Block, useKeyboard, type KeyboardController } from './keyboard-common.tsx';
import {
  TC2048_ROWS,
  TC2048_SCENE,
  placeTc2048Rows,
  type PlacedTc2048Key,
} from './tc2048-keyboard.ts';

// The cursor keys 5-8 print a solid block arrow on the case, not a glyph.
const ARROWS: Readonly<Record<string, { box: string; path: string }>> = {
  '←': { box: '0 0 20 10', path: 'M20 3.5H9V0L0 5l9 5V6.5h11z' },
  '→': { box: '0 0 20 10', path: 'M0 3.5h11V0l9 5-9 5V6.5H0z' },
  '↑': { box: '0 0 10 20', path: 'M3.5 20V9H0L5 0l5 9H6.5v11z' },
  '↓': { box: '0 0 10 20', path: 'M3.5 0v11H0l5 9 5-9H6.5V0z' },
};

function Tc2048Key(props: { placed: PlacedTc2048Key; kbd: KeyboardController }) {
  const d = () => props.placed.key;
  const cells = () => [...d().cells] as [number, number][];
  const kind = () => d().kind;
  return (
    <>
      <SceneElement box={props.placed.cell} class="tck-cell" ariaHidden>{' '}</SceneElement>

      <SceneElement box={props.placed.above} class="tck-above">
        {/* Every number key keeps its colour line, blank on 8 and 9, so the commands line up. */}
        <Show when={kind() === 'num'}>
          <span
            class="tck-colour"
            style={d().colour !== 'BLACK' && d().colourCss ? { color: d().colourCss } : undefined}
          >{d().colour ?? '\u00a0'}</span>
        </Show>
        <Show when={d().above}>
          <Show
            when={ARROWS[d().above ?? '']}
            fallback={<span class="tck-word">{d().above}</span>}
          >
            {(arrow) => (
              <svg
                class="tck-arrow"
                classList={{ 'tck-arrow--vertical': d().above === '↑' || d().above === '↓' }}
                viewBox={arrow().box}
                aria-hidden="true"
              >
                <path d={arrow().path} />
              </svg>
            )}
          </Show>
        </Show>
      </SceneElement>

      <SceneKey
        box={props.placed.cap}
        class={`tck-key tck-key--${kind()}${d().dark ? ' tck-key--dark' : ''}`}
        pressed={props.kbd.isDown(cells())}
        label={d().main.replace('\n', ' ')}
        onDown={() => props.kbd.onDown(cells(), d().latch)}
        onUp={() => props.kbd.onUp(cells(), d().latch)}
      >
        <Show when={kind() === 'num' || kind() === 'letter'}>
          <span class="tck-main">{d().main === '0' ? 'Ø' : d().main}</span>
          <Show when={d().block}>{(n) => <Block n={n()} class="tck-block" />}</Show>
          <Show when={d().keyword}><span class="tck-keyword">{d().keyword}</span></Show>
          <Show when={d().strip}><span class="tck-strip">{d().strip}</span></Show>
        </Show>
        <Show when={kind() === 'special'}>
          <span class="tck-label">
            <For each={d().main.split('\n')}>{(line) => <span>{line}</span>}</For>
          </span>
        </Show>
      </SceneKey>

      <SceneElement box={props.placed.below} class="tck-below">
        <Show when={d().below}><span class="tck-word">{d().below}</span></Show>
      </SceneElement>
    </>
  );
}

export function KeyboardTc2048() {
  const kbd = useKeyboard();
  const keys = placeTc2048Rows(TC2048_ROWS);
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={TC2048_SCENE.width}
        height={TC2048_SCENE.height}
        unit={TC2048_SCENE.unit}
        class="tck-bezel"
        label="Timex Computer 2048 keyboard"
      >
        <For each={keys}>{(placed) => <Tc2048Key placed={placed} kbd={kbd} />}</For>
      </KeyboardScene>
    </Pane>
  );
}
