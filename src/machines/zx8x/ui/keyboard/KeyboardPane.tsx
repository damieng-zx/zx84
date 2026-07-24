/**
 * ZX81 / ZX80 on-screen keyboard.
 *
 * A staggered 4×10 grid of flat keycaps on a textured case (see `legends.ts`).
 * Each key prints the keyword above / FUNCTION word below on the case, and the
 * glyph + red shifted-function (top) + red SHIFT token (upper-right) + block
 * swatch on the cap — matching the real machine. The model chooses the face
 * (ZX81 black case / silver caps, ZX80 black case / blue caps). Both drive the
 * live `Zx8xKeyboard` matrix and highlight from it — see `useKeyboard()`.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { currentModel } from '@/state/machine-state.ts';
import { KeyboardScene, SceneElement, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { rowsForModel, type Graphic } from './legends.ts';
import { useKeyboard, type KeyboardController } from './keyboard-common.tsx';
import {
  placeZx8xRows,
  zx8xScene,
  type PlacedZx8xKey,
} from './scene-geometry.ts';

// Cursor keys 5–8 print a big fat outline arrow instead of a small glyph.
const ARROW_OUTLINE: Record<string, string> = { '←': '⇦', '↓': '⇩', '↑': '⇧', '→': '⇨' };

// Quadrant origins in the block's 4×4 cell grid: TL, TR, BL, BR.
const HALF = 4;
const QUAD_ORIGIN: [number, number][] = [[0, 0], [HALF, 0], [0, HALF], [HALF, HALF]];

/**
 * A 2×2 block-graphics swatch drawn as crisp SVG. Each quadrant is blank (0),
 * solid black (1) or a fine black/white checker (2 — the ZX81 "grey" stipple);
 * the checker tiles continuously across quadrants so adjacent halves line up.
 */
function Block(props: { g: Graphic }) {
  const rects = () => {
    const out: { x: number; y: number; w: number; h: number }[] = [];
    props.g.forEach((fill, qi) => {
      const [ox, oy] = QUAD_ORIGIN[qi];
      if (fill === 1) {
        out.push({ x: ox, y: oy, w: HALF, h: HALF });
      } else if (fill === 2) {
        for (let dx = 0; dx < HALF; dx++) {
          for (let dy = 0; dy < HALF; dy++) {
            const x = ox + dx, y = oy + dy;
            if ((x + y) % 2 === 0) out.push({ x, y, w: 1, h: 1 });
          }
        }
      }
    });
    return out;
  };
  return (
    <svg class="zxk-block" viewBox={`0 0 ${HALF * 2} ${HALF * 2}`} shape-rendering="crispEdges" aria-hidden="true">
      <For each={rects()}>{(r) => <rect x={r.x} y={r.y} width={r.w} height={r.h} />}</For>
    </svg>
  );
}

function KeyCell(props: { placed: PlacedZx8xKey; kbd: KeyboardController; zx80?: boolean }) {
  const k = props.placed.key;
  const pressed = () => props.kbd.isDown(k.pos);
  const arrow = () => (k.capFn ? ARROW_OUTLINE[k.capFn] : undefined);
  // The ZX81 prints the shifted function (EDIT, arrows…) on the cap; the ZX80
  // prints everything secondary above the key, so its number functions move up.
  const above = () => (props.zx80 ? (k.keyword ?? k.capFn) : k.keyword);
  return (
    <>
      {/* On the case above: keyword (both) plus the shifted function on the ZX80. */}
      <SceneElement
        box={props.placed.above}
        class={`zxk-above${above() === 'BREAK' ? ' zxk-above--break' : ''}`}
      >
        {above() ?? ' '}
      </SceneElement>
      <SceneKey
        box={props.placed.cap}
        class={[
          'zxk-key',
          k.latch ? 'zxk-key--mod' : '',
          k.main.includes('\n') || k.main.length > 1 ? 'zxk-key--label' : '',
          /^[0-9]$/.test(k.main) ? 'zxk-key--num' : '',
        ].filter(Boolean).join(' ')}
        pressed={pressed()}
        label={k.main.replace('\n', ' ')}
        onDown={() => props.kbd.onDown(k.pos, k.latch)}
        onUp={() => props.kbd.onUp(k.pos, k.latch)}
      >
        {/* Red shifted-function at the top of the cap. Cursor keys print a big
            fat outline arrow; everything else prints the word. */}
        <Show when={!props.zx80 && k.capFn}>
          <span class="zxk-capfn" classList={{ 'zxk-capfn--arrow': !!arrow() }}>{arrow() ?? k.capFn}</span>
        </Show>
        <span class="zxk-main">{k.main}</span>
        {/* Red shift tokens that are symbols (no letters) print larger than words. */}
        <Show when={k.shift}>
          <span class="zxk-shift" classList={{ 'zxk-shift--sym': !/[A-Za-z]/.test(k.shift!) }}>{k.shift}</span>
        </Show>
        <Show when={k.graphic}>{(g) => <Block g={g()} />}</Show>
      </SceneKey>
      {/* On the case below: white FUNCTION word (ZX81 letter keys). */}
      <SceneElement box={props.placed.below} class="zxk-below">{k.func ?? ' '}</SceneElement>
    </>
  );
}

export function KeyboardPane() {
  const model = () => (currentModel() === 'zx80' ? 'zx80' : 'zx81');
  const rows = () => rowsForModel(model());
  const scene = () => zx8xScene(model());
  const keys = () => placeZx8xRows(rows(), model());
  const kbd = useKeyboard();
  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <KeyboardScene
        width={scene().width}
        height={scene().height}
        unit={scene().unit}
        class="zxk-bezel"
        classList={{ 'zxk--zx81': model() === 'zx81', 'zxk--zx80': model() === 'zx80' }}
        label={model() === 'zx80' ? 'Sinclair ZX80 keyboard' : 'Sinclair ZX81 keyboard'}
      >
        <For each={keys()}>
          {(placed) => <KeyCell placed={placed} kbd={kbd} zx80={model() === 'zx80'} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
