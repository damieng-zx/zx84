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
import { Pane } from '@/ui/components/Pane.tsx';
import { activeSpectrum } from '@/machines/spectrum/ui/active.ts';
import { currentModel } from '@/state/machine-state.ts';
import { machineDescriptor } from '@/state/machine-caps.ts';
import { is128kClass } from '@/machines/spectrum/models.ts';
import { Block, useKeyboard, type KeyboardController, type LatchMode } from './keyboard-common.tsx';
import { KeyboardPlus } from './KeyboardPlus.tsx';
import { sparseKeyboardFace } from './plus2-legends.ts';
import { lettersFor, numbersFor } from './legends.ts';
import type { MachineLocale } from '@/machines/machine.ts';

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

/** Build the rubber-keyboard row data for a given locale. */
function buildKeyRows(locale: MachineLocale): KeyDef[][] {
  const ltrs = lettersFor(locale);
  const nums = numbersFor(locale);

  return [
    // Number row
    [
      { kind: 'num', pos: [3, 0], main: '1', red: nums['1'].red!, block: nums['1'].block!, color: nums['1'].color, colorCss: nums['1'].colorCss, cmd: nums['1'].cmd, below: nums['1'].ext },
      { kind: 'num', pos: [3, 1], main: '2', red: nums['2'].red!, block: nums['2'].block!, color: nums['2'].color, colorCss: nums['2'].colorCss, cmd: nums['2'].cmd, below: nums['2'].ext },
      { kind: 'num', pos: [3, 2], main: '3', red: nums['3'].red!, block: nums['3'].block!, color: nums['3'].color, colorCss: nums['3'].colorCss, cmd: nums['3'].cmd, below: nums['3'].ext },
      { kind: 'num', pos: [3, 3], main: '4', red: nums['4'].red!, block: nums['4'].block!, color: nums['4'].color, colorCss: nums['4'].colorCss, cmd: nums['4'].cmd, below: nums['4'].ext },
      { kind: 'num', pos: [3, 4], main: '5', red: nums['5'].red!, block: nums['5'].block!, color: nums['5'].color, colorCss: nums['5'].colorCss, cmd: nums['5'].cmd, below: nums['5'].ext },
      { kind: 'num', pos: [4, 4], main: '6', red: nums['6'].red!, block: nums['6'].block!, color: nums['6'].color, colorCss: nums['6'].colorCss, cmd: nums['6'].cmd, below: nums['6'].ext },
      { kind: 'num', pos: [4, 3], main: '7', red: nums['7'].red!, block: nums['7'].block!, color: nums['7'].color, colorCss: nums['7'].colorCss, cmd: nums['7'].cmd, below: nums['7'].ext },
      { kind: 'num', pos: [4, 2], main: '8', red: nums['8'].red!, block: nums['8'].block!,                                     cmd: nums['8'].cmd, below: nums['8'].ext },
      { kind: 'num', pos: [4, 1], main: '9', red: nums['9'].red!,                                                 cmd: nums['9'].cmd, below: nums['9'].ext },
      { kind: 'num', pos: [4, 0], main: '0', red: nums['0'].red!,           color: nums['0'].color, colorCss: nums['0'].colorCss, cmd: nums['0'].cmd, below: nums['0'].ext },
    ],
    // Q row
    [
      { kind: 'letter', pos: [2, 0], main: 'Q', red: ltrs.Q.red,  word: ltrs.Q.word, green: ltrs.Q.green, below: ltrs.Q.ess },
      { kind: 'letter', pos: [2, 1], main: 'W', red: ltrs.W.red,  word: ltrs.W.word, green: ltrs.W.green, below: ltrs.W.ess },
      { kind: 'letter', pos: [2, 2], main: 'E', red: ltrs.E.red,  word: ltrs.E.word, green: ltrs.E.green, below: ltrs.E.ess },
      { kind: 'letter', pos: [2, 3], main: 'R', red: ltrs.R.red,  word: ltrs.R.word, green: ltrs.R.green, below: ltrs.R.ess },
      { kind: 'letter', pos: [2, 4], main: 'T', red: ltrs.T.red,  word: ltrs.T.word, green: ltrs.T.green, below: ltrs.T.ess },
      { kind: 'letter', pos: [5, 4], main: 'Y', red: ltrs.Y.red,  word: ltrs.Y.word, green: ltrs.Y.green, below: ltrs.Y.ess },
      { kind: 'letter', pos: [5, 3], main: 'U', red: ltrs.U.red,  word: ltrs.U.word, green: ltrs.U.green, below: ltrs.U.ess },
      { kind: 'letter', pos: [5, 2], main: 'I', red: ltrs.I.red,  word: ltrs.I.word, green: ltrs.I.green, below: ltrs.I.ess },
      { kind: 'letter', pos: [5, 1], main: 'O', red: ltrs.O.red,  word: ltrs.O.word, green: ltrs.O.green, below: ltrs.O.ess },
      { kind: 'letter', pos: [5, 0], main: 'P', red: ltrs.P.red,  word: ltrs.P.word, green: ltrs.P.green, below: ltrs.P.ess },
    ],
    // A row
    [
      { kind: 'letter', pos: [1, 0], main: 'A', red: ltrs.A.red,  word: ltrs.A.word, green: ltrs.A.green, below: ltrs.A.ess },
      { kind: 'letter', pos: [1, 1], main: 'S', red: ltrs.S.red,  word: ltrs.S.word, green: ltrs.S.green, below: ltrs.S.ess },
      { kind: 'letter', pos: [1, 2], main: 'D', red: ltrs.D.red,  word: ltrs.D.word, green: ltrs.D.green, below: ltrs.D.ess },
      { kind: 'letter', pos: [1, 3], main: 'F', red: ltrs.F.red,  word: ltrs.F.word, green: ltrs.F.green, below: ltrs.F.ess },
      { kind: 'letter', pos: [1, 4], main: 'G', red: ltrs.G.red,  word: ltrs.G.word, green: ltrs.G.green, below: ltrs.G.ess },
      { kind: 'letter', pos: [6, 4], main: 'H', red: ltrs.H.red,  word: ltrs.H.word, green: ltrs.H.green, below: ltrs.H.ess },
      { kind: 'letter', pos: [6, 3], main: 'J', red: ltrs.J.red,  word: ltrs.J.word, green: ltrs.J.green, below: ltrs.J.ess },
      { kind: 'letter', pos: [6, 2], main: 'K', red: ltrs.K.red,  word: ltrs.K.word, green: ltrs.K.green, below: ltrs.K.ess },
      { kind: 'letter', pos: [6, 1], main: 'L', red: ltrs.L.red,  word: ltrs.L.word, green: ltrs.L.green, below: ltrs.L.ess },
      { kind: 'special', pos: [6, 0], main: 'ENTER' },
    ],
    // Z row
    [
      { kind: 'special', pos: [0, 0], main: 'CAPS\nSHIFT', latch: 'oneshot', w: 1.25 },
      { kind: 'letter', pos: [0, 1], main: 'Z', red: ltrs.Z.red, word: ltrs.Z.word, green: ltrs.Z.green, below: ltrs.Z.ess },
      { kind: 'letter', pos: [0, 2], main: 'X', red: ltrs.X.red, word: ltrs.X.word, green: ltrs.X.green, below: ltrs.X.ess },
      { kind: 'letter', pos: [0, 3], main: 'C', red: ltrs.C.red, word: ltrs.C.word, green: ltrs.C.green, below: ltrs.C.ess },
      { kind: 'letter', pos: [0, 4], main: 'V', red: ltrs.V.red, word: ltrs.V.word, green: ltrs.V.green, below: ltrs.V.ess },
      { kind: 'letter', pos: [7, 4], main: 'B', red: ltrs.B.red, word: ltrs.B.word, green: ltrs.B.green, below: ltrs.B.ess },
      { kind: 'letter', pos: [7, 3], main: 'N', red: ltrs.N.red, word: ltrs.N.word, green: ltrs.N.green, below: ltrs.N.ess },
      { kind: 'letter', pos: [7, 2], main: 'M', red: ltrs.M.red, word: ltrs.M.word, green: ltrs.M.green, below: ltrs.M.ess },
      { kind: 'special', pos: [7, 1], main: 'SYMBOL\nSHIFT', redLabel: true, latch: 'oneshot' },
      { kind: 'special', pos: [7, 0], main: 'BREAK\nSPACE', bigLast: true, w: 1.75 },
    ],
  ];
}

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
  const rows = () => buildKeyRows(machineDescriptor().locale);
  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <div class="kbd-bezel">
        <div class="kbd-keys">
          <For each={rows()}>
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
