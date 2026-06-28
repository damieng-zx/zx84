/**
 * ZX Spectrum + / 128K ("toastrack") on-screen keyboard.
 *
 * A full hard-key layout. Unlike the rubber 48K (legends printed on the bezel
 * around the keys), the + prints every legend *inside* the keycap, so the keys
 * are a flush, uniform-height grid of proportionally-sized rows:
 *
 *   row 1:  TRUE VIDEO  INV VIDEO   1 2 3 4 5 6 7 8 9 0           BREAK
 *   row 2:  DELETE  GRAPH   Q W E R T Y U I O P             ┐ L-shaped
 *   row 3:  EXTEND  EDIT    A S D F G H J K L          ENTER ┘
 *   row 4:  CAPS SHIFT  CAPS LOCK   Z X C V B N M  .   CAPS SHIFT
 *   row 5:  SYMBOL SHIFT  ; "  ← →   [SPACE]   ↑ ↓ ,   SYMBOL SHIFT
 *
 * The dedicated keys are CAPS/SYMBOL-SHIFT combos on the real matrix (DELETE =
 * CAPS+0, ← = CAPS+5, ; = SYM+O, …). The mode keys latch: CAPS/SYMBOL SHIFT are
 * one-shots; EXTEND MODE, GRAPH and CAPS LOCK hold until clicked again. ENTER is
 * the L-shaped Sinclair return key, rendered as two joined cells.
 */

import { For, Show } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { spectrum } from '@/emulator.ts';
import {
  POS, CS, SS, LETTERS, NUMBERS, Block, useKeyboard,
  type KeyboardController, type LatchMode,
} from './keyboard-common.tsx';
import { plus2KeepsRed, plus2KeyWidth, PLUS2_KEYWORDS } from './plus2-legends.ts';

type PVariant = 'num' | 'letter' | 'fn' | 'mod' | 'enter-top' | 'enter-bottom' | 'space' | 'sym' | 'arrow';

interface PKey {
  variant: PVariant;
  positions: [number, number][];
  w?: number;          // width units (flex-grow); default 1
  latch?: LatchMode;   // sticky key (CAPS/SYMBOL SHIFT, EXTEND/GRAPH/CAPS LOCK)
  main?: string;       // big glyph (letter / digit / punctuation / arrow)
  red?: string;        // red symbol-shift token (letters/numbers)
  word?: string;       // white K-mode keyword (letters)
  green?: string;      // green extended keyword (letters)
  ess?: string;        // red extended+symbol-shift keyword (letters)
  color?: string; colorCss?: string; ext?: string; block?: number; // number keys
  label?: string;      // fn/mod/enter label (lines joined with '\n')
  redLabel?: boolean;  // colour the label red (SYMBOL SHIFT)
}

// ── Key builders ────────────────────────────────────────────────────────
const letter = (g: string): PKey => ({ variant: 'letter', main: g, positions: [POS[g]], ...LETTERS[g] });
const number = (g: string): PKey => ({ variant: 'num', main: g, positions: [POS[g]], ...NUMBERS[g] });
const fn = (label: string, positions: [number, number][], w = 1.4, latch?: LatchMode): PKey =>
  ({ variant: 'fn', label, positions, w, latch });
const mod = (label: string, pos: [number, number], w: number, redLabel = false): PKey =>
  ({ variant: 'mod', label, positions: [pos], latch: 'oneshot', w, redLabel });
const sym = (g: string, positions: [number, number][]): PKey => ({ variant: 'sym', main: g, positions });
const arrow = (g: string, positions: [number, number][]): PKey => ({ variant: 'arrow', main: g, positions });

// +2 cursor-key glyph → chevron direction (the sparse face draws a CSS chevron).
const CHEV: Record<string, string> = { '←': 'left', '→': 'right', '↑': 'up', '↓': 'down' };

const ENTER_TOP: PKey = { variant: 'enter-top', positions: [POS.ENTER], w: 1.3 };
const ENTER_BOTTOM: PKey = { variant: 'enter-bottom', label: 'ENTER', positions: [POS.ENTER], w: 2.6 };

const ROW1: PKey[] = [
  fn('TRUE\nVIDEO', [CS, POS['3']], 1.5),
  fn('INV\nVIDEO', [CS, POS['4']], 1.5),
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map(number),
  fn('BREAK', [CS, POS.SPACE], 1.5),
];

const ROW2: PKey[] = [
  fn('DELETE', [CS, POS['0']], 1.7),
  fn('GRAPH', [CS, POS['9']], 1.4, 'hold'),
  ...['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'].map(letter),
  ENTER_TOP,
];

const ROW3: PKey[] = [
  fn('EXTEND\nMODE', [CS, SS], 1.7, 'hold'),
  fn('EDIT', [CS, POS['1']], 1.4),
  ...['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'].map(letter),
  ENTER_BOTTOM,
];

const ROW4: PKey[] = [
  mod('CAPS\nSHIFT', CS, 2.0),
  fn('CAPS\nLOCK', [CS, POS['2']], 1.4, 'hold'),
  ...['Z', 'X', 'C', 'V', 'B', 'N', 'M'].map(letter),
  sym('.', [SS, POS.M]),
  mod('CAPS\nSHIFT', CS, 2.0),
];

const ROW5: PKey[] = [
  mod('SYMBOL\nSHIFT', SS, 1.6, true),
  sym(';', [SS, POS.O]),
  sym('"', [SS, POS.P]),
  arrow('←', [CS, POS['5']]),
  arrow('→', [CS, POS['8']]),
  { variant: 'space', positions: [POS.SPACE], w: 6 },
  arrow('↑', [CS, POS['7']]),
  arrow('↓', [CS, POS['6']]),
  sym(',', [SS, POS.N]),
  mod('SYMBOL\nSHIFT', SS, 1.6, true),
];

function KeyBody(props: { k: PKey; sparse?: boolean }) {
  const k = props.k;
  // The white keyword the grey +2 keeps on this cap, if any (RUN/CODE/LOAD).
  const keyword = () => (k.main ? PLUS2_KEYWORDS[k.main] : undefined);
  // On the +2 the wide command keys print their label on one line, SYMBOL SHIFT
  // is abbreviated to SYM SHIFT.
  const labelText = () => {
    const l = k.label ?? '';
    if (!props.sparse) return l;
    if (k.variant === 'mod' && l.startsWith('SYMBOL')) return 'SYMB\nSHIFT';
    if ((k.variant === 'mod' && l.startsWith('CAPS')) || l === 'EXTEND\nMODE') return l.replace('\n', ' ');
    return l;
  };
  return (
    <>
      {/* Full 128K/+ legends */}
      <Show when={k.variant === 'num' && !props.sparse}>
        <Show when={k.color}>
          <span
            class="pk-tl"
            classList={{ 'pk-tl--black': k.color === 'BLACK' }}
            style={k.colorCss && k.color !== 'BLACK' ? { color: k.colorCss } : undefined}
          >
            {k.color}
          </span>
        </Show>
        <span class="pk-tr pk-white">{k.ext}</span>
        <Show when={k.block}>{(n) => <Block n={n()} class="pk-block" />}</Show>
        <span class="pk-mr pk-red">{k.red}</span>
        <span class="pk-main">{k.main}</span>
      </Show>

      <Show when={k.variant === 'letter' && !props.sparse}>
        <span class="pk-tl pk-green">{k.green}</span>
        <span class="pk-tr pk-red">{k.ess}</span>
        <span class="pk-ml pk-white">{k.word}</span>
        <span class="pk-mr pk-red">{k.red}</span>
        <span class="pk-main">{k.main}</span>
      </Show>

      {/* Sparse grey +2 legends: the symbol-shift token (and any surviving
          keyword — RUN/CODE/LOAD) sit white, italic and centred above the main
          glyph, matching the bare +2 caps. */}
      <Show when={k.variant === 'num' && props.sparse}>
        <span class="pk2-top"><span class="pk2-sym">{k.red}</span></span>
        <span class="pk-main">{k.main}</span>
      </Show>

      <Show when={k.variant === 'letter' && props.sparse}>
        <span class="pk2-top">
          <Show when={plus2KeepsRed(k.red)}><span class="pk2-sym">{k.red}</span></Show>
          <Show when={keyword()}><span class="pk2-word">{keyword()}</span></Show>
        </span>
        <span class="pk-main">{k.main}</span>
      </Show>

      <Show when={k.variant === 'sym' || (k.variant === 'arrow' && !props.sparse)}>
        <span class="pk-glyph">{k.main}</span>
      </Show>

      {/* +2 cursor keys are chevrons, not full arrows. */}
      <Show when={k.variant === 'arrow' && props.sparse}>
        <span class="pk-glyph"><i class={`pk2-chev pk2-chev--${CHEV[k.main ?? '']}`} /></span>
      </Show>

      <Show when={k.variant === 'fn' || k.variant === 'mod' || k.variant === 'enter-bottom'}>
        <span class="pk-label">
          <For each={labelText().split('\n')}>{(line) => <span>{line}</span>}</For>
        </span>
      </Show>
    </>
  );
}

function PCell(props: { k: PKey; kbd: KeyboardController; sparse?: boolean }) {
  const k = props.k;
  const pressed = () => props.kbd.isDown(k.positions);
  return (
    <div
      class={`pk-key pk-key--${k.variant}`}
      classList={{ pressed: pressed(), 'pk-key--red': k.redLabel }}
      // Sparse +2: fixed-width grid via the --w unit count (the CSS turns it into
      // a real width). Toastrack: flex-grow so the row fills the pane.
      style={props.sparse
        ? { '--w': `${plus2KeyWidth(k.variant, k.label, k.w ?? 1)}` }
        : { flex: `${k.w ?? 1} 1 0` }}
      role="button"
      aria-pressed={pressed()}
      aria-label={(k.label ?? k.main ?? '').replace('\n', ' ')}
      onPointerDown={(e) => {
        if (!spectrum) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        props.kbd.onDown(k.positions, k.latch);
      }}
      onPointerUp={() => props.kbd.onUp(k.positions, k.latch)}
      onPointerCancel={() => props.kbd.onUp(k.positions, k.latch)}
    >
      <KeyBody k={k} sparse={props.sparse} />
    </div>
  );
}

function PRow(props: { keys: PKey[]; kbd: KeyboardController; sparse?: boolean }) {
  return (
    <div class="kbd-prow">
      <For each={props.keys}>{(k) => <PCell k={k} kbd={props.kbd} sparse={props.sparse} />}</For>
    </div>
  );
}

/**
 * The hard-key + / 128K keyboard. With `sparse` it renders the stripped-down
 * +2 face (see plus2-legends); `amstrad` darkens the case to the near-black
 * +2A/+3 colours.
 */
export function KeyboardPlus(props: { sparse?: boolean; amstrad?: boolean }) {
  const kbd = useKeyboard();
  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <div class="kbd-plus" classList={{ 'kbd-plus--grey2': props.sparse, 'kbd-plus--amstrad': props.amstrad }}>
        <PRow keys={ROW1} kbd={kbd} sparse={props.sparse} />
        <PRow keys={ROW2} kbd={kbd} sparse={props.sparse} />
        <PRow keys={ROW3} kbd={kbd} sparse={props.sparse} />
        <PRow keys={ROW4} kbd={kbd} sparse={props.sparse} />
        <PRow keys={ROW5} kbd={kbd} sparse={props.sparse} />
      </div>
    </Pane>
  );
}
