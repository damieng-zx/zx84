/**
 * ZX Spectrum + / 128K ("toastrack") on-screen keyboard.
 *
 * A full hard-key layout. Unlike the rubber 48K (legends printed on the bezel
 * around the keys), the + prints every legend *inside* the keycap, so the keys
 * are a flush grid of fixed-pitch caps — 1u is square (1u = key height) and the
 * command keys are sized in quarter-units:
 *
 *   row 1:  TRUE VIDEO  INV VIDEO   1 2 3 4 5 6 7 8 9 0           BREAK
 *   row 2:  DELETE  GRAPH   Q W E R T Y U I O P             ┐ L-shaped
 *   row 3:  EXTEND  EDIT    A S D F G H J K L          ENTER ┘
 *   row 4:  CAPS SHIFT  CAPS LOCK   Z X C V B N M  .   CAPS SHIFT
 *   row 5:  SYMBOL SHIFT  ; "  ← →   [SPACE]   ↑ ↓ ,   SYMBOL SHIFT
 *
 * Every legend on the toastrack is printed white. The dedicated keys are
 * CAPS/SYMBOL-SHIFT combos on the real matrix (DELETE = CAPS+0, ← = CAPS+5,
 * ; = SYM+O, …). The mode keys latch: CAPS/SYMBOL SHIFT are one-shots; EXTEND
 * MODE, GRAPH and CAPS LOCK hold until clicked again. ENTER is the L-shaped
 * Sinclair return key, drawn as a single SVG "boot" outline (see bootPath).
 */

import { For, Show, createUniqueId } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { KeyboardScene, SceneKey } from '@/ui/components/KeyboardScene.tsx';
import { machineDescriptor } from '@/state/machine-caps.ts';
import {
  POS, CS, SS, Block, useKeyboard,
  type KeyboardController, type LatchMode,
} from './keyboard-common.tsx';
import { lettersFor, numbersFor } from './keyboard-common.tsx';
import { plus2KeepsRed, plus2KeyWidth, PLUS2_KEYWORDS, PLUS2_DEDICATED_SYMBOLS } from './plus2-legends.ts';
import {
  hardScene,
  placeHardRows,
  type HardFace,
  type PlacedHardKey,
} from './scene-geometry.ts';

type PVariant = 'num' | 'letter' | 'fn' | 'mod' | 'enter' | 'space' | 'sym' | 'arrow';

interface PKey {
  variant: PVariant;
  positions: [number, number][];
  w?: number;          // width units (1u = square); default 1
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

/** Build a letter-keyfactory from a locale-specific legend map. */
function mkLetter(ltrs: Record<string, import('./keyboard-common.tsx').LetterLegend>) {
  return (g: string): PKey => ({ variant: 'letter', main: g, positions: [POS[g]], ...ltrs[g] });
}

/** Build a number-key factory from a locale-specific legend map. */
function mkNumber(nums: Record<string, import('./keyboard-common.tsx').NumberLegend>) {
  return (g: string): PKey => ({ variant: 'num', main: g, positions: [POS[g]], ...nums[g] });
}
const fn = (label: string, positions: [number, number][], w = 1, latch?: LatchMode): PKey =>
  ({ variant: 'fn', label, positions, w, latch });
const mod = (label: string, pos: [number, number], w: number, redLabel = false): PKey =>
  ({ variant: 'mod', label, positions: [pos], latch: 'oneshot', w, redLabel });
const sym = (g: string, positions: [number, number][]): PKey => ({ variant: 'sym', main: g, positions });
const arrow = (g: string, positions: [number, number][]): PKey => ({ variant: 'arrow', main: g, positions });

// +2 cursor-key glyph → chevron direction (the sparse face draws a CSS chevron).
const CHEV: Record<string, string> = { '←': 'left', '→': 'right', '↑': 'up', '↓': 'down' };

// Toastrack cursor caps print a big open (outline) arrow glyph.
const OUTLINE_ARROW: Record<string, string> = { '←': '⇦', '→': '⇨', '↑': '⇧', '↓': '⇩' };

// The L-shaped ("boot") Sinclair ENTER is one scene key and one SVG outline.
// Its measured hit region spans the stem in row 2 and the wider foot in row 3.
const ENTER: PKey = { variant: 'enter', label: 'ENTER', positions: [POS.ENTER], w: 1 };

// Boot geometry in "design pixels" (each ×--pu1 in CSS, so it scales with the
// display scale). The two faces differ only in unit pitch (48 vs 49) and row gap
// (2 vs 4); see the metrics table in the keyboard CSS.
interface BootMetrics { Wf: number; H: number; footTop: number; N: number; r: number }
const BOOT_TOASTRACK: BootMetrics = { Wf: 82, H: 94, footTop: 48, N: 36, r: 3 };
const BOOT_SPARSE: BootMetrics = { Wf: 82.75, H: 96, footTop: 50, N: 36.75, r: 3 };

// One continuous outline of the boot, clockwise from the top of the stem. Five
// rounded outer corners (arc sweep 1) and the single rounded inner corner at the
// notch (sweep 0). Coordinates are viewBox units = design pixels.
function bootPath(m: BootMetrics): string {
  const { Wf, H, footTop, N, r } = m;
  return [
    `M ${N + r} 0`,
    `L ${Wf - r} 0`, `A ${r} ${r} 0 0 1 ${Wf} ${r}`,        // stem/foot top-right
    `L ${Wf} ${H - r}`, `A ${r} ${r} 0 0 1 ${Wf - r} ${H}`, // bottom-right
    `L ${r} ${H}`, `A ${r} ${r} 0 0 1 0 ${H - r}`,          // bottom-left
    `L 0 ${footTop + r}`, `A ${r} ${r} 0 0 1 ${r} ${footTop}`, // foot top-left
    `L ${N - r} ${footTop}`, `A ${r} ${r} 0 0 0 ${N} ${footTop - r}`, // inner notch corner
    `L ${N} ${r}`, `A ${r} ${r} 0 0 1 ${N + r} 0`,          // stem top-left
    'Z',
  ].join(' ');
}

// The boot's up-facing edges (stem top + the foot overhang's top ledge). A light
// hairline here 1px inside the outline is the ENTER's version of every cap's
// `inset 0 1px 0` top highlight, so the L reads as a raised keycap.
function bootHighlight(m: BootMetrics): string {
  const { Wf, footTop, N, r } = m;
  return [
    `M ${N + r} 1`, `L ${Wf - r} 1`,                        // stem top ledge
    `M ${r} ${footTop + 1}`, `L ${N - r} ${footTop + 1}`,   // foot overhang top ledge
  ].join(' ');
}

// The boot's down-facing bottom edge — a softer dark line matching the caps'
// `inset 0 -2px 3px` bottom shadow.
function bootShadow(m: BootMetrics): string {
  const { Wf, H, r } = m;
  return [`M ${r} ${H - 1}`, `L ${Wf - r} ${H - 1}`].join(' ');
}

/** Build all five keyboard rows for a given locale. */
function buildRows(locale: import('@/machines/machine.ts').MachineLocale) {
  const ltrs = lettersFor(locale);
  const nums = numbersFor(locale);
  const letter = mkLetter(ltrs);
  const number = mkNumber(nums);

  const ROW1: PKey[] = [
    fn('TRUE\nVIDEO', [CS, POS['3']], 1),
    fn('INV\nVIDEO', [CS, POS['4']], 1),
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map(number),
    fn('BREAK', [CS, POS.SPACE], 1.5),
  ];

  const ROW2: PKey[] = [
    fn('DELETE', [CS, POS['0']], 1.5),
    fn('GRAPH', [CS, POS['9']], 1, 'hold'),
    ...['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'].map(letter),
    ENTER,
  ];

  const ROW3: PKey[] = [
    fn('EXTEND\nMODE', [CS, SS], 1.5, 'hold'),
    fn('EDIT', [CS, POS['1']], 1.25),
    ...['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'].map(letter),
  ];

  const ROW4: PKey[] = [
    mod('CAPS\nSHIFT', CS, 2.25),
    fn('CAPS\nLOCK', [CS, POS['2']], 1, 'hold'),
    ...['Z', 'X', 'C', 'V', 'B', 'N', 'M'].map(letter),
    sym('.', [SS, POS.M]),
    mod('CAPS\nSHIFT', CS, 2.25),
  ];

  const ROW5: PKey[] = [
    mod('SYMBOL\nSHIFT', SS, 1, true),
    sym(';', [SS, POS.O]),
    sym('"', [SS, POS.P]),
    arrow('←', [CS, POS['5']]),
    arrow('→', [CS, POS['8']]),
    { variant: 'space', positions: [POS.SPACE], w: 4.5 },
    arrow('↑', [CS, POS['7']]),
    arrow('↓', [CS, POS['6']]),
    sym(',', [SS, POS.N]),
    mod('SYMBOL\nSHIFT', SS, 1, true),
  ];

  return [ROW1, ROW2, ROW3, ROW4, ROW5];
}

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
      {/* Full 128K/+ legends — all printed white on the toastrack. */}
      {/* Number caps stack like the letters: colour name, extended keyword, the
          block-graphic swatch and symbol-shift token together on one row, then
          the digit (e.g. 1 → BLUE / DEF FN / ▘! / 1). Keys with no colour (8, 9)
          keep a blank top line so every digit lines up. */}
      <Show when={k.variant === 'num' && !props.sparse}>
        <span class="pk-stack">
          <span class="pk-leg">{k.color ?? ' '}</span>
          <span class="pk-leg">{k.ext}</span>
          <span class="pk-leg pk-numrow">
            <Show when={k.block}>{(n) => <Block n={n()} class="pk-block-inline" />}</Show>
            <span>{k.red}</span>
          </span>
          <span class="pk-leg pk-leg--main">{k.main}</span>
        </span>
      </Show>

      {/* Each legend on its own line, top to bottom: extended keyword,
          extended+symbol-shift keyword, K-mode keyword, symbol-shift token,
          then the main glyph (e.g. Q → SIN / ASN / PLOT / <= / Q). O/P/N/M
          leave the symbol-shift line blank (their token — ; " , . — has its own
          dedicated key) so every cap keeps five rows and the glyphs line up. */}
      <Show when={k.variant === 'letter' && !props.sparse}>
        <span class="pk-stack">
          <span class="pk-leg">{k.green}</span>
          <span class="pk-leg">{k.ess}</span>
          <span class="pk-leg">{k.word}</span>
          <span class="pk-leg">{PLUS2_DEDICATED_SYMBOLS.has(k.red ?? '') ? ' ' : k.red}</span>
          <span class="pk-leg pk-leg--main">{k.main}</span>
        </span>
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

      <Show when={k.variant === 'sym'}>
        <span class="pk-glyph">{k.main}</span>
      </Show>

      {/* Toastrack cursor keys: big white outline arrows. */}
      <Show when={k.variant === 'arrow' && !props.sparse}>
        <span class="pk-glyph pk-arrow">{OUTLINE_ARROW[k.main ?? '']}</span>
      </Show>

      {/* +2 cursor keys are chevrons, not full arrows. */}
      <Show when={k.variant === 'arrow' && props.sparse}>
        <span class="pk-glyph"><i class={`pk2-chev pk2-chev--${CHEV[k.main ?? '']}`} /></span>
      </Show>

      <Show when={k.variant === 'fn' || k.variant === 'mod'}>
        <span class="pk-label">
          <For each={labelText().split('\n')}>{(line) => <span>{line}</span>}</For>
        </span>
      </Show>
    </>
  );
}

// A rounded-rect keycap drawn with the same recipe as the ENTER boot (gradient
// fill + top-highlight + bottom-shadow + drop shadow), so every cap — rectangles
// and the boot — shares one rendering path. The viewBox matches the key's own
// unit size, so preserveAspectRatio="none" scales it uniformly and the corner
// radius stays circular at any key width.
function RectCap(props: { w: number; sparse?: boolean }) {
  const gradId = createUniqueId();
  const W = () => (props.sparse ? props.w * 49 - 3 : props.w * 48 - 2); // design-px width
  const H = 46, r = 3;
  return (
    <svg class="pk-cap-svg" viewBox={`0 0 ${W()} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop class="pk-cap-g0" offset="0" />
          <stop class="pk-cap-g1" offset="0.45" />
          <stop class="pk-cap-g2" offset="1" />
        </linearGradient>
      </defs>
      <rect class="pk-cap-rect" x="0.5" y="0.5" width={W() - 1} height={H - 1} rx={r} ry={r} fill={`url(#${gradId})`} vector-effect="non-scaling-stroke" />
      <line class="pk-cap-hi" x1={r} y1="1.5" x2={W() - r} y2="1.5" vector-effect="non-scaling-stroke" />
      <line class="pk-cap-lo" x1={r} y1={H - 1.5} x2={W() - r} y2={H - 1.5} vector-effect="non-scaling-stroke" />
    </svg>
  );
}

function PCell(props: { placed: PlacedHardKey<PKey>; kbd: KeyboardController; sparse?: boolean }) {
  const k = props.placed.key;
  const pressed = () => props.kbd.isDown(k.positions);
  const boot = () => (props.sparse ? BOOT_SPARSE : BOOT_TOASTRACK);
  const gradId = createUniqueId();
  const wUnits = () => (props.sparse ? plus2KeyWidth(k.variant, k.label, k.w ?? 1) : (k.w ?? 1));
  // Every cap draws an SVG except the boot ENTER, which owns its own path.
  const svgCap = () => k.variant !== 'enter';
  const hitClip = () => {
    if (k.variant !== 'enter') return undefined;
    const m = boot();
    const notchX = m.N / m.Wf * 100;
    const footY = m.footTop / m.H * 100;
    return `polygon(${notchX}% 0, 100% 0, 100% 100%, 0 100%, 0 ${footY}%, ${notchX}% ${footY}%)`;
  };
  return (
    <SceneKey
      box={props.placed.cap}
      class={`pk-key pk-key--${k.variant}${k.redLabel ? ' pk-key--red' : ''}`}
      pressed={pressed()}
      label={(k.label ?? k.main ?? (k.variant === 'space' ? 'SPACE' : '')).replace('\n', ' ')}
      hitClip={hitClip()}
      onDown={() => props.kbd.onDown(k.positions, k.latch)}
      onUp={() => props.kbd.onUp(k.positions, k.latch)}
    >
      {/* An SVG rounded-rect cap behind the (unchanged HTML) label. */}
      <Show when={svgCap()}><RectCap w={wUnits()} sparse={props.sparse} /></Show>
      {/* The L-shaped ENTER renders as one SVG boot (overflowing the 1u stem cell
          down and left into row 3); every other key renders its normal cap. */}
      <Show when={k.variant === 'enter'} fallback={<KeyBody k={k} sparse={props.sparse} />}>
        <svg class="pk-enter-svg" viewBox={`0 0 ${boot().Wf} ${boot().H}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            {/* The boot is double-height, so its mid stop sits lower than a normal
                cap's 0.45 — otherwise the mid-tone lands up at the stem and the
                foot reads darker than the single-height caps beside it. */}
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop class="pk-enter-g0" offset="0" />
              <stop class="pk-enter-g1" offset="0.75" />
              <stop class="pk-enter-g2" offset="1" />
            </linearGradient>
          </defs>
          <path class="pk-enter-shape" fill={`url(#${gradId})`} vector-effect="non-scaling-stroke" d={bootPath(boot())} />
          <path class="pk-enter-hi" vector-effect="non-scaling-stroke" d={bootHighlight(boot())} />
          <path class="pk-enter-lo" vector-effect="non-scaling-stroke" d={bootShadow(boot())} />
        </svg>
        <span class="pk-enter-label">{k.label}</span>
      </Show>
    </SceneKey>
  );
}

/**
 * The hard-key + / 128K keyboard. With `sparse` it renders the stripped-down
 * +2 face (see plus2-legends); `amstrad` darkens the case to the near-black
 * +2A/+3 colours.
 */
export function KeyboardPlus(props: { sparse?: boolean; amstrad?: boolean }) {
  const kbd = useKeyboard();
  const locale = () => machineDescriptor().locale;
  const rows = () => buildRows(locale());
  const face = (): HardFace => props.sparse ? 'sparse' : 'toastrack';
  const metrics = () => hardScene(face());
  const widthOf = (key: PKey) =>
    props.sparse ? plus2KeyWidth(key.variant, key.label, key.w ?? 1) : (key.w ?? 1);
  const keys = () => placeHardRows(rows(), face(), widthOf);
  return (
    <Pane id="keyboard-panel" label="Keyboard">
      <KeyboardScene
        width={metrics().width}
        height={metrics().height}
        unit={metrics().unit}
        class="kbd-plus"
        classList={{ 'kbd-plus--grey2': props.sparse, 'kbd-plus--amstrad': props.amstrad }}
        label="ZX Spectrum hard-key keyboard"
      >
        <For each={keys()}>
          {(placed) => <PCell placed={placed} kbd={kbd} sparse={props.sparse} />}
        </For>
      </KeyboardScene>
    </Pane>
  );
}
