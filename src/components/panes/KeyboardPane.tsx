/**
 * 48K Spectrum rubber keyboard — interactive on-screen keyboard.
 *
 * Reproduces the iconic ZX Spectrum 48K keyboard face: a dark rubber mat with
 * the full four-legend-per-key set printed exactly where the real machine has
 * them —
 *
 *   • on the key:    white main glyph, white K-mode keyword, red symbol-shift
 *                    token (and, on the number row, the block-graphics swatch).
 *   • above the key: green extended-mode keyword (and, on the number row, the
 *                    colour name + the white cursor/EDIT command).
 *   • below the key: red extended-plus-symbol-shift keyword.
 *
 * Every key is the same width — the real 48K is a uniform 4×10 grid, including
 * CAPS SHIFT / ENTER / SYMBOL SHIFT / BREAK SPACE.
 *
 * Each key maps 1:1 to a ZX keyboard-matrix [row, bit] and drives the live
 * machine via `spectrum.keyboard.setKey`:
 *   • Ordinary keys are momentary — press on pointer-down, release on
 *     pointer-up (pointer capture means a drag-off still releases). Holding a
 *     key auto-repeats through the ROM, exactly as on hardware.
 *   • CAPS SHIFT and SYMBOL SHIFT are sticky one-shots — click to latch (so a
 *     combo is possible with a single pointer), then the next key releases them
 *     automatically; click again to unlatch.
 *
 * Key highlighting is driven off the live matrix, so keys light up for physical
 * keystrokes too, not just pointer presses.
 */

import { For, Show, createSignal, onMount, onCleanup } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { spectrum } from '@/emulator.ts';

type Kind = 'num' | 'letter' | 'special';

interface KeyDef {
  kind: Kind;
  pos: [number, number]; // ZX keyboard matrix [row, bit]
  main: string;       // big glyph; for 'special', lines joined with '\n'
  red?: string;       // red symbol-shift token on the key
  word?: string;      // white K-mode keyword on the key (letters)
  green?: string;     // green extended-mode keyword (above the key)
  below?: string;     // red extended+symbol-shift keyword (below the key)
  // number-row legends above the key:
  color?: string;     // ZX colour name
  colorCss?: string;  // colour to draw the name in
  cmd?: string;       // white cursor / EDIT / DELETE command
  block?: number;     // 1..8 block-graphics swatch
  // special keys:
  bigLast?: boolean;  // render the last label line large (BREAK SPACE)
  redLabel?: boolean; // colour the special label red (SYMBOL SHIFT)
  modifier?: boolean; // sticky one-shot modifier (CAPS SHIFT / SYMBOL SHIFT)
}

// Block-graphics swatches printed on number keys 1–8: which of the four
// quadrants [top-left, top-right, bottom-left, bottom-right] are filled.
const BLOCKS: Record<number, [boolean, boolean, boolean, boolean]> = {
  1: [true, false, false, false],
  2: [false, true, false, false],
  3: [true, true, false, false],
  4: [false, false, true, false],
  5: [true, false, true, false],
  6: [false, true, true, false],
  7: [true, true, true, false],
  8: [false, false, false, true],
};

const KEY_ROWS: KeyDef[][] = [
  // Number row — colour name + white command above, red symbol + block on key,
  // red extended keyword below.
  [
    { kind: 'num', pos: [3, 0], main: '1', red: '!', block: 1, color: 'BLUE',    colorCss: '#2f7bff', cmd: 'EDIT',       below: 'DEF FN' },
    { kind: 'num', pos: [3, 1], main: '2', red: '@', block: 2, color: 'RED',     colorCss: '#ff3b3b', cmd: 'CAPS LOCK',  below: 'FN' },
    { kind: 'num', pos: [3, 2], main: '3', red: '#', block: 3, color: 'MAGENTA', colorCss: '#d24bd2', cmd: 'TRUE VIDEO', below: 'LINE' },
    { kind: 'num', pos: [3, 3], main: '4', red: '$', block: 4, color: 'GREEN',   colorCss: '#33cc55', cmd: 'INV. VIDEO', below: 'OPEN #' },
    { kind: 'num', pos: [3, 4], main: '5', red: '%', block: 5, color: 'CYAN',    colorCss: '#2ad2d2', cmd: '←',     below: 'CLOSE #' },
    { kind: 'num', pos: [4, 4], main: '6', red: '&', block: 6, color: 'YELLOW',  colorCss: '#e6d62e', cmd: '↓',     below: 'MOVE' },
    { kind: 'num', pos: [4, 3], main: '7', red: "'", block: 7, color: 'WHITE',   colorCss: '#ffffff', cmd: '↑',     below: 'ERASE' },
    { kind: 'num', pos: [4, 2], main: '8', red: '(', block: 8,                                        cmd: '→',     below: 'POINT' },
    { kind: 'num', pos: [4, 1], main: '9', red: ')',                                                  cmd: 'GRAPHICS',   below: 'CAT' },
    { kind: 'num', pos: [4, 0], main: '0', red: '_',           color: 'BLACK',   colorCss: '#000',    cmd: 'DELETE',     below: 'FORMAT' },
  ],
  // Q row
  [
    { kind: 'letter', pos: [2, 0], main: 'Q', red: '<=',  word: 'PLOT',   green: 'SIN',   below: 'ASN' },
    { kind: 'letter', pos: [2, 1], main: 'W', red: '<>',  word: 'DRAW',   green: 'COS',   below: 'ACS' },
    { kind: 'letter', pos: [2, 2], main: 'E', red: '>=',  word: 'REM',    green: 'TAN',   below: 'ATN' },
    { kind: 'letter', pos: [2, 3], main: 'R', red: '<',   word: 'RUN',    green: 'INT',   below: 'VERIFY' },
    { kind: 'letter', pos: [2, 4], main: 'T', red: '>',   word: 'RAND',   green: 'RND',   below: 'MERGE' },
    { kind: 'letter', pos: [5, 4], main: 'Y', red: 'AND', word: 'RETURN', green: 'STR $', below: '[' },
    { kind: 'letter', pos: [5, 3], main: 'U', red: 'OR',  word: 'IF',     green: 'CHR $', below: ']' },
    { kind: 'letter', pos: [5, 2], main: 'I', red: 'AT',  word: 'INPUT',  green: 'CODE',  below: 'IN' },
    { kind: 'letter', pos: [5, 1], main: 'O', red: ';',   word: 'POKE',   green: 'PEEK',  below: 'OUT' },
    { kind: 'letter', pos: [5, 0], main: 'P', red: '"',   word: 'PRINT',  green: 'TAB',   below: '©' },
  ],
  // A row
  [
    { kind: 'letter', pos: [1, 0], main: 'A', red: 'STOP',   word: 'NEW',   green: 'READ',    below: '~' },
    { kind: 'letter', pos: [1, 1], main: 'S', red: 'NOT',    word: 'SAVE',  green: 'RESTORE', below: '|' },
    { kind: 'letter', pos: [1, 2], main: 'D', red: 'STEP',   word: 'DIM',   green: 'DATA',    below: '\\' },
    { kind: 'letter', pos: [1, 3], main: 'F', red: 'TO',     word: 'FOR',   green: 'SGN',     below: '{' },
    { kind: 'letter', pos: [1, 4], main: 'G', red: 'THEN',   word: 'GOTO',  green: 'ABS',     below: '}' },
    { kind: 'letter', pos: [6, 4], main: 'H', red: '↑', word: 'GOSUB', green: 'SQR',     below: 'CIRCLE' },
    { kind: 'letter', pos: [6, 3], main: 'J', red: '−', word: 'LOAD',  green: 'VAL',     below: 'VAL $' },
    { kind: 'letter', pos: [6, 2], main: 'K', red: '+',      word: 'LIST',  green: 'LEN',     below: 'SCREEN $' },
    { kind: 'letter', pos: [6, 1], main: 'L', red: '=',      word: 'LET',   green: 'USR',     below: 'ATTR' },
    { kind: 'special', pos: [6, 0], main: 'ENTER' },
  ],
  // Z row
  [
    { kind: 'special', pos: [0, 0], main: 'CAPS\nSHIFT', modifier: true },
    { kind: 'letter', pos: [0, 1], main: 'Z', red: ':', word: 'COPY',   green: 'LN',      below: 'BEEP' },
    { kind: 'letter', pos: [0, 2], main: 'X', red: '£', word: 'CLEAR',  green: 'EXP',     below: 'INK' },
    { kind: 'letter', pos: [0, 3], main: 'C', red: '?', word: 'CONT',   green: 'L PRINT', below: 'PAPER' },
    { kind: 'letter', pos: [0, 4], main: 'V', red: '/', word: 'CLS',    green: 'L LIST',  below: 'FLASH' },
    { kind: 'letter', pos: [7, 4], main: 'B', red: '*', word: 'BORDER', green: 'BIN',     below: 'BRIGHT' },
    { kind: 'letter', pos: [7, 3], main: 'N', red: ',', word: 'NEXT',   green: 'INKEY $', below: 'OVER' },
    { kind: 'letter', pos: [7, 2], main: 'M', red: '.', word: 'PAUSE',  green: 'PI',      below: 'INVERSE' },
    { kind: 'special', pos: [7, 1], main: 'SYMBOL\nSHIFT', redLabel: true, modifier: true },
    { kind: 'special', pos: [7, 0], main: 'BREAK\nSPACE', bigLast: true },
  ],
];

const ROWS_RELEASED = (): number[] => [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function Block(props: { n: number }) {
  return (
    <span class="k-block">
      <For each={BLOCKS[props.n]}>{(on) => <i classList={{ on }} />}</For>
    </span>
  );
}

function KeyCell(props: { d: KeyDef; pressed: () => boolean; down: () => void; up: () => void }) {
  const d = props.d;
  return (
    <div class="kbd-cell">
      {/* Above-key legends */}
      <div class={`kbd-above kbd-above--${d.kind}`}>
        <Show when={d.kind === 'num'}>
          <span
            class="kbd-color"
            classList={{ 'kbd-color--black': d.color === 'BLACK' }}
            style={d.colorCss && d.color !== 'BLACK' ? { color: d.colorCss } : undefined}
          >
            {d.color ?? ' '}
          </span>
          <span class="kbd-cmd">{d.cmd ?? ' '}</span>
        </Show>
        <Show when={d.kind === 'letter'}>
          <span class="kbd-green">{d.green ?? ' '}</span>
        </Show>
      </div>

      {/* The key */}
      <div
        class={`kbd-key kbd-key--${d.kind}`}
        classList={{ 'kbd-key--red': d.redLabel, pressed: props.pressed() }}
        role="button"
        aria-pressed={props.pressed()}
        aria-label={d.main.replace('\n', ' ')}
        onPointerDown={(e) => {
          if (!spectrum) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          props.down();
        }}
        onPointerUp={() => props.up()}
        onPointerCancel={() => props.up()}
      >
        <Show when={d.kind === 'num'}>
          <span class="k-num">{d.main}</span>
          <Show when={d.block}>{(n) => <Block n={n()} />}</Show>
          <Show when={d.red}><span class="k-numsym">{d.red}</span></Show>
        </Show>

        <Show when={d.kind === 'letter'}>
          <span class="k-letter">{d.main}</span>
          <Show when={d.red}><span class="k-redtok">{d.red}</span></Show>
          <Show when={d.word}><span class="k-word">{d.word}</span></Show>
        </Show>

        <Show when={d.kind === 'special'}>
          <span class="k-special" classList={{ 'k-special--biglast': d.bigLast }}>
            <For each={d.main.split('\n')}>{(line) => <span>{line}</span>}</For>
          </span>
        </Show>
      </div>

      {/* Below-key legend */}
      <div class="kbd-below">{d.below ?? ' '}</div>
    </div>
  );
}

export function KeyboardPane() {
  // Live mirror of the 8 ZX matrix half-rows (active-low). Drives key
  // highlighting for both pointer presses and physical keystrokes.
  const [matrix, setMatrix] = createSignal<number[]>(ROWS_RELEASED());
  // Latched sticky modifiers, keyed by "row,bit".
  const [latched, setLatched] = createSignal<ReadonlySet<string>>(new Set<string>());

  const isPressed = (pos: [number, number]) => (matrix()[pos[0]] & (1 << pos[1])) === 0;

  const onDown = (d: KeyDef) => {
    const kb = spectrum?.keyboard;
    if (!kb) return;
    const [row, bit] = d.pos;
    if (d.modifier) {
      // Toggle the latch — held down until the next key, or until clicked again.
      const key = `${row},${bit}`;
      const next = new Set(latched());
      if (next.has(key)) {
        next.delete(key);
        kb.setKey(row, bit, false);
      } else {
        next.add(key);
        kb.setKey(row, bit, true);
      }
      setLatched(next);
    } else {
      kb.setKey(row, bit, true);
    }
  };

  const onUp = (d: KeyDef) => {
    const kb = spectrum?.keyboard;
    if (!kb || d.modifier) return; // modifiers toggle on press only
    kb.setKey(d.pos[0], d.pos[1], false);
    // One-shot: releasing an ordinary key drops any latched modifiers too.
    const set = latched();
    if (set.size) {
      for (const k of set) {
        const [r, b] = k.split(',').map(Number);
        kb.setKey(r, b, false);
      }
      setLatched(new Set<string>());
    }
  };

  // Poll the live matrix once per frame so highlighting tracks the real machine
  // state (pointer presses, physical keys, and latched modifiers alike).
  onMount(() => {
    let raf = 0;
    const tick = () => {
      const kb = spectrum?.keyboard;
      if (kb) {
        const r = kb.rows;
        const cur = matrix();
        let changed = false;
        for (let i = 0; i < 8; i++) {
          if (r[i] !== cur[i]) { changed = true; break; }
        }
        if (changed) setMatrix(Array.from(r));
      } else if (matrix().some((b) => b !== 0xff)) {
        setMatrix(ROWS_RELEASED());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <div class="kbd-bezel">
        <For each={KEY_ROWS}>
          {(row) => (
            <div class="kbd-row">
              <For each={row}>
                {(key) => (
                  <KeyCell
                    d={key}
                    pressed={() => isPressed(key.pos)}
                    down={() => onDown(key)}
                    up={() => onUp(key)}
                  />
                )}
              </For>
            </div>
          )}
        </For>
        <span class="kbd-rainbow" aria-hidden="true" />
      </div>
    </Pane>
  );
}
