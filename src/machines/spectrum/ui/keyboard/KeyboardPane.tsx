/**
 * On-screen keyboard pane.
 *
 * Picks the keyboard that matches the current machine: the rubber 48K membrane
 * for 16K/48K, and the hard-key Spectrum + / 128K layout for the 128K-class
 * models (128K, +2, +2A, +3). Both drive the live machine and highlight from
 * the real keyboard matrix — see keyboard-common.
 *
 * This file owns the rubber 48K keyboard; the + lives in KeyboardPlus.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { activeSpectrum } from '@/machines/spectrum/ui/active.ts';
import { currentModel } from '@/state/machine-state.ts';
import { is128kClass } from '@/machines/spectrum/models.ts';
import { Block, useKeyboard, type KeyboardController, type LatchMode } from './keyboard-common.tsx';
import { KeyboardPlus } from './KeyboardPlus.tsx';
import { sparseKeyboardFace } from './plus2-legends.ts';

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
  latch?: LatchMode;  // sticky one-shot modifier (CAPS SHIFT / SYMBOL SHIFT)
  w?: number;         // width in key units (default 1)
}

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
    { kind: 'special', pos: [0, 0], main: 'CAPS\nSHIFT', latch: 'oneshot', w: 1.25 },
    { kind: 'letter', pos: [0, 1], main: 'Z', red: ':', word: 'COPY',   green: 'LN',      below: 'BEEP' },
    { kind: 'letter', pos: [0, 2], main: 'X', red: '£', word: 'CLEAR',  green: 'EXP',     below: 'INK' },
    { kind: 'letter', pos: [0, 3], main: 'C', red: '?', word: 'CONT',   green: 'L PRINT', below: 'PAPER' },
    { kind: 'letter', pos: [0, 4], main: 'V', red: '/', word: 'CLS',    green: 'L LIST',  below: 'FLASH' },
    { kind: 'letter', pos: [7, 4], main: 'B', red: '*', word: 'BORDER', green: 'BIN',     below: 'BRIGHT' },
    { kind: 'letter', pos: [7, 3], main: 'N', red: ',', word: 'NEXT',   green: 'INKEY $', below: 'OVER' },
    { kind: 'letter', pos: [7, 2], main: 'M', red: '.', word: 'PAUSE',  green: 'PI',      below: 'INVERSE' },
    { kind: 'special', pos: [7, 1], main: 'SYMBOL\nSHIFT', redLabel: true, latch: 'oneshot' },
    { kind: 'special', pos: [7, 0], main: 'BREAK\nSPACE', bigLast: true, w: 1.75 },
  ],
];

function KeyCell(props: { d: KeyDef; kbd: KeyboardController }) {
  const d = props.d;
  const pos: [number, number][] = [d.pos];
  const pressed = () => props.kbd.isDown(pos);
  return (
    <div class="kbd-cell" style={d.w ? { '--w': `${d.w}` } : undefined}>
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
        classList={{ 'kbd-key--red': d.redLabel, pressed: pressed() }}
        role="button"
        aria-pressed={pressed()}
        aria-label={d.main.replace('\n', ' ')}
        onPointerDown={(e) => {
          if (!activeSpectrum()) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          props.kbd.onDown(pos, d.latch);
        }}
        onPointerUp={() => props.kbd.onUp(pos, d.latch)}
        onPointerCancel={() => props.kbd.onUp(pos, d.latch)}
      >
        <Show when={d.kind === 'num'}>
          <span class="k-num">{d.main}</span>
          <Show when={d.block}>{(n) => <Block n={n()} />}</Show>
          <Show when={d.red}><span class="k-numsym">{d.red}</span></Show>
        </Show>

        <Show when={d.kind === 'letter'}>
          <span class="k-letter">{d.main}</span>
          <Show when={d.red}>
            <span
              class="k-redtok"
              classList={{
                'k-redtok--word': /[A-Za-z]/.test(d.red ?? ''),
                'k-redtok--big': ['*', ',', '.'].includes(d.red ?? ''),
              }}
            >{d.red}</span>
          </Show>
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

function KeyboardRubber() {
  const kbd = useKeyboard();
  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <div class="kbd-bezel">
        <div class="kbd-keys">
          <For each={KEY_ROWS}>
            {(row) => (
              <div class="kbd-row">
                <For each={row}>{(key) => <KeyCell d={key} kbd={kbd} />}</For>
              </div>
            )}
          </For>
        </div>
      </div>
    </Pane>
  );
}

/**
 * The hard-key keyboard for the 128K-class models. The +2 uses the sparse grey
 * face and the +2A/+3 the sparse near-black face; the 128K shows the full
 * 128K/+ legends.
 */
function KeyboardHard() {
  const face = () => sparseKeyboardFace(currentModel());
  return <KeyboardPlus sparse={face() !== null} amstrad={face() === 'amstrad'} />;
}

export function KeyboardPane() {
  return (
    <Show when={is128kClass(currentModel())} fallback={<KeyboardRubber />}>
      <KeyboardHard />
    </Show>
  );
}
