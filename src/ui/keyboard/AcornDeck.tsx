/**
 * The Acorn ASCII deck, shared by the machines that used it.
 *
 * The Atom's built-in keyboard and the separate ASCII keyboard sold for the
 * System machines are the same 61-key deck: ESC, the number row, Q/A/Z, the
 * space bar, with the arrow keys, COPY and DELETE on the left and the control
 * keys down the right. Each machine supplies its own `driver` — the Atom drives
 * a 10x6 matrix cell, the System machines put an ASCII code on a port — and its
 * own badge, so the pane is the same deck with the right behaviour underneath.
 */

import { For, Index, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import type { DeckKeyDef } from './deck-layout.ts';
import {
  DECK_BADGE_BOX, DECK_PLATE_BOX, DECK_SCENE, placeDeckKeys, type PlacedDeckKey,
} from './deck-geometry.ts';

/** What a machine has to provide to put this deck on screen. */
export interface DeckDriver {
  isDown(key: DeckKeyDef): boolean;
  onDown(key: DeckKeyDef): void;
  onUp(key: DeckKeyDef): void;
}

function DeckKey(props: { placed: PlacedDeckKey; driver: DeckDriver }) {
  const key = props.placed.key;
  const lines = key.main.split('\n');
  return (
    <SceneKey
      box={props.placed.box}
      class={`atom-key atom-key--${key.region}${key.shift ? ' atom-key--shifted' : ''}`}
      pressed={props.driver.isDown(key)}
      label={key.main.replace('\n', ' ') || 'SPACE'}
      onDown={() => props.driver.onDown(key)}
      onUp={() => props.driver.onUp(key)}
    >
      <Show when={key.region !== 'space'}>
        <span class="atom-key__legend">
          <Show when={key.shift}>
            <span class="atom-key__shift">{key.shift}</span>
          </Show>
          <Index each={lines}>{(line) => <span class="atom-key__main">{line()}</span>}</Index>
        </span>
      </Show>
    </SceneKey>
  );
}

export function AcornDeck(props: {
  driver: DeckDriver;
  /** Printed on the badge beside the space bar. */
  badge: string;
  /** Accessible name of the deck. */
  label: string;
}) {
  return (
    <Pane id="keyboard-panel" label="Keyboard" floatable>
      <KeyboardScene
        width={DECK_SCENE.width}
        height={DECK_SCENE.height}
        unit={1}
        fill
        class="atom-keyboard"
        label={props.label}
      >
        <SceneElement box={DECK_PLATE_BOX} class="atom-plate" />
        <For each={placeDeckKeys()}>
          {(placed) => <DeckKey placed={placed} driver={props.driver} />}
        </For>
        <SceneElement box={DECK_BADGE_BOX} class="atom-badge">
          {props.badge}
        </SceneElement>
      </KeyboardScene>
    </Pane>
  );
}
