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
import { activeZx8x } from '@/machines/zx8x/ui/active.ts';
import { rowsForModel, type Zx8xKey, type Graphic } from './legends.ts';
import { useKeyboard, type KeyboardController } from './keyboard-common.tsx';

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

function KeyCell(props: { k: Zx8xKey; kbd: KeyboardController }) {
  const k = props.k;
  const pressed = () => props.kbd.isDown(k.pos);
  const arrow = () => (k.capFn ? ARROW_OUTLINE[k.capFn] : undefined);
  return (
    <div class="zxk-cell">
      {/* On the case above: the white K-mode keyword (letter keys). */}
      <div class="zxk-above">{k.keyword ?? ' '}</div>
      <div
        class="zxk-key"
        classList={{ 'zxk-key--mod': k.latch, 'zxk-key--label': k.main.includes('\n') || k.main.length > 1, pressed: pressed() }}
        role="button"
        aria-pressed={pressed()}
        aria-label={k.main.replace('\n', ' ')}
        onPointerDown={(e) => {
          if (!activeZx8x()) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          props.kbd.onDown(k.pos, k.latch);
        }}
        onPointerUp={() => props.kbd.onUp(k.pos, k.latch)}
        onPointerCancel={() => props.kbd.onUp(k.pos, k.latch)}
      >
        {/* Red shifted-function at the top of the cap. Cursor keys print a big
            fat outline arrow; everything else prints the word. */}
        <Show when={k.capFn}>
          <span class="zxk-capfn" classList={{ 'zxk-capfn--arrow': !!arrow() }}>{arrow() ?? k.capFn}</span>
        </Show>
        <span class="zxk-main">{k.main}</span>
        {/* Red shift tokens that are symbols (no letters) print larger than words. */}
        <Show when={k.shift}>
          <span class="zxk-shift" classList={{ 'zxk-shift--sym': !/[A-Za-z]/.test(k.shift!) }}>{k.shift}</span>
        </Show>
        <Show when={k.graphic}>{(g) => <Block g={g()} />}</Show>
      </div>
      {/* On the case below: white FUNCTION word (ZX81 letter keys). */}
      <div class="zxk-below">{k.func ?? ' '}</div>
    </div>
  );
}

export function KeyboardPane() {
  const model = () => (currentModel() === 'zx80' ? 'zx80' : 'zx81');
  const rows = () => rowsForModel(model());
  const kbd = useKeyboard();
  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <div class="zxk-bezel" classList={{ 'zxk--zx81': model() === 'zx81', 'zxk--zx80': model() === 'zx80' }}>
        <div class="zxk-keys">
          <For each={rows()}>
            {(row) => (
              <div class="zxk-row">
                <For each={row}>{(key) => <KeyCell k={key} kbd={kbd} />}</For>
              </div>
            )}
          </For>
        </div>
      </div>
    </Pane>
  );
}
