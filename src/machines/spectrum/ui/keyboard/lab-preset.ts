import type {
  KeyboardLabDocument,
  KeyboardLabKey,
} from '@/ui/keyboard-lab/types.ts';
import { lettersFor, numbersFor } from './legends.ts';
import {
  plus2KeepsRed,
  plus2KeyWidth,
  PLUS2_KEYWORDS,
} from './plus2-legends.ts';
import {
  hardScene,
  placeHardRows,
  placeRubberRows,
  RUBBER_SCENE,
  type HardFace,
} from './scene-geometry.ts';

type Cell = readonly [row: number, bit: number];

const POS: Readonly<Record<string, Cell>> = {
  '1': [3, 0], '2': [3, 1], '3': [3, 2], '4': [3, 3], '5': [3, 4],
  '6': [4, 4], '7': [4, 3], '8': [4, 2], '9': [4, 1], '0': [4, 0],
  Q: [2, 0], W: [2, 1], E: [2, 2], R: [2, 3], T: [2, 4],
  Y: [5, 4], U: [5, 3], I: [5, 2], O: [5, 1], P: [5, 0],
  A: [1, 0], S: [1, 1], D: [1, 2], F: [1, 3], G: [1, 4],
  H: [6, 4], J: [6, 3], K: [6, 2], L: [6, 1],
  Z: [0, 1], X: [0, 2], C: [0, 3], V: [0, 4],
  B: [7, 4], N: [7, 3], M: [7, 2],
  ENTER: [6, 0], SPACE: [7, 0], CAPS: [0, 0], SYM: [7, 1],
};

const CS = POS.CAPS;
const SS = POS.SYM;

type RubberKind = 'num' | 'letter' | 'special';

interface RubberKey {
  readonly kind: RubberKind;
  readonly pos: Cell;
  readonly main: string;
  readonly red?: string;
  readonly word?: string;
  readonly green?: string;
  readonly below?: string;
  readonly color?: string;
  readonly cmd?: string;
  readonly w?: number;
}

function rubberRows(): RubberKey[][] {
  const letters = lettersFor('uk');
  const numbers = numbersFor('uk');
  const number = (main: string): RubberKey => ({
    kind: 'num',
    pos: POS[main],
    main,
    red: numbers[main].red,
    color: numbers[main].color,
    cmd: numbers[main].cmd,
    below: numbers[main].ext,
  });
  const letter = (main: string): RubberKey => ({
    kind: 'letter',
    pos: POS[main],
    main,
    red: letters[main].red,
    word: letters[main].word,
    green: letters[main].green,
    below: letters[main].ess,
  });
  return [
    [...'1234567890'].map(number),
    [...'QWERTYUIOP'].map(letter),
    [
      ...[...'ASDFGHJKL'].map(letter),
      { kind: 'special', pos: POS.ENTER, main: 'ENTER' },
    ],
    [
      { kind: 'special', pos: CS, main: 'CAPS\nSHIFT', w: 1.25 },
      ...[...'ZXCVBNM'].map(letter),
      { kind: 'special', pos: SS, main: 'SYMBOL\nSHIFT' },
      { kind: 'special', pos: POS.SPACE, main: 'BREAK\nSPACE', w: 1.75 },
    ],
  ];
}

type HardVariant = 'num' | 'letter' | 'fn' | 'mod' | 'enter' | 'space' | 'sym' | 'arrow';

interface HardKey {
  readonly variant: HardVariant;
  readonly positions: readonly Cell[];
  readonly w?: number;
  readonly main?: string;
  readonly red?: string;
  readonly word?: string;
  readonly green?: string;
  readonly ess?: string;
  readonly color?: string;
  readonly ext?: string;
  readonly label?: string;
}

function hardRows(): HardKey[][] {
  const letters = lettersFor('uk');
  const numbers = numbersFor('uk');
  const letter = (main: string): HardKey => ({
    variant: 'letter',
    main,
    positions: [POS[main]],
    ...letters[main],
  });
  const number = (main: string): HardKey => ({
    variant: 'num',
    main,
    positions: [POS[main]],
    ...numbers[main],
  });
  const command = (label: string, positions: readonly Cell[], w = 1): HardKey =>
    ({ variant: 'fn', label, positions, w });
  const modifier = (label: string, position: Cell, w: number): HardKey =>
    ({ variant: 'mod', label, positions: [position], w });
  const symbol = (main: string, positions: readonly Cell[]): HardKey =>
    ({ variant: 'sym', main, positions });
  const arrow = (main: string, positions: readonly Cell[]): HardKey =>
    ({ variant: 'arrow', main, positions });

  return [
    [
      command('TRUE\nVIDEO', [CS, POS['3']]),
      command('INV\nVIDEO', [CS, POS['4']]),
      ...[...'1234567890'].map(number),
      command('BREAK', [CS, POS.SPACE], 1.5),
    ],
    [
      command('DELETE', [CS, POS['0']], 1.5),
      command('GRAPH', [CS, POS['9']]),
      ...[...'QWERTYUIOP'].map(letter),
      { variant: 'enter', label: 'ENTER', positions: [POS.ENTER], w: 1 },
    ],
    [
      command('EXTEND\nMODE', [CS, SS], 1.5),
      command('EDIT', [CS, POS['1']], 1.25),
      ...[...'ASDFGHJKL'].map(letter),
    ],
    [
      modifier('CAPS\nSHIFT', CS, 2.25),
      command('CAPS\nLOCK', [CS, POS['2']]),
      ...[...'ZXCVBNM'].map(letter),
      symbol('.', [SS, POS.M]),
      modifier('CAPS\nSHIFT', CS, 2.25),
    ],
    [
      modifier('SYMBOL\nSHIFT', SS, 1),
      symbol(';', [SS, POS.O]),
      symbol('"', [SS, POS.P]),
      arrow('←', [CS, POS['5']]),
      arrow('→', [CS, POS['8']]),
      { variant: 'space', positions: [POS.SPACE], w: 4.5 },
      arrow('↑', [CS, POS['7']]),
      arrow('↓', [CS, POS['6']]),
      symbol(',', [SS, POS.N]),
      modifier('SYMBOL\nSHIFT', SS, 1),
    ],
  ];
}

function slug(value: string): string {
  const arrows: Readonly<Record<string, string>> = {
    '←': 'left',
    '→': 'right',
    '↑': 'up',
    '↓': 'down',
  };
  const normalized = arrows[value] ?? value;
  return normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'key';
}

function uniqueIds(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  return values.map((value) => {
    const base = slug(value);
    const occurrence = (counts.get(base) ?? 0) + 1;
    counts.set(base, occurrence);
    return occurrence === 1 ? base : `${base}-${occurrence}`;
  });
}

function compactLegend(values: readonly (string | undefined)[]): string | undefined {
  const present = values.filter((value): value is string => !!value?.trim());
  return present.length ? present.join(' · ') : undefined;
}

function rubberDocument(): KeyboardLabDocument {
  const placed = placeRubberRows(rubberRows());
  const ids = uniqueIds(placed.map(({ key }) => key.main));
  return {
    version: 1,
    id: 'spectrum-48k',
    name: 'ZX Spectrum 48K',
    theme: 'spectrum48',
    scene: RUBBER_SCENE,
    keys: placed.map(({ key, cap }, index): KeyboardLabKey => ({
      id: ids[index],
      box: { ...cap },
      cell: key.pos,
      legends: {
        main: key.main,
        shift: compactLegend([key.red, key.word, key.color, key.cmd, key.green]),
        aux: key.below,
      },
      tone: 'dark',
      region: key.kind,
      shape: 'rectangle',
    })),
  };
}

function hardMain(key: HardKey): string {
  return key.label ?? key.main ?? (key.variant === 'space' ? 'SPACE' : '');
}

function hardEnterClip(sparse: boolean): string {
  const metrics = sparse
    ? { width: 82.75, height: 96, footTop: 50, notch: 36.75 }
    : { width: 82, height: 94, footTop: 48, notch: 36 };
  const notchX = metrics.notch / metrics.width * 100;
  const footY = metrics.footTop / metrics.height * 100;
  return `polygon(${notchX}% 0, 100% 0, 100% 100%, 0 100%, 0 ${footY}%, ${notchX}% ${footY}%)`;
}

function hardDocument(
  id: string,
  name: string,
  sparse: boolean,
  theme: string,
): KeyboardLabDocument {
  const rows = hardRows();
  const face: HardFace = sparse ? 'sparse' : 'toastrack';
  const placed = placeHardRows(
    rows,
    face,
    (key) => sparse
      ? plus2KeyWidth(key.variant, key.label, key.w ?? 1)
      : key.w ?? 1,
  );
  const ids = uniqueIds(placed.map(({ key }) => hardMain(key) || key.variant));
  return {
    version: 1,
    id,
    name,
    theme,
    scene: hardScene(face),
    keys: placed.map(({ key, cap }, index): KeyboardLabKey => ({
      id: ids[index],
      box: { ...cap },
      cell: key.positions[0],
      legends: {
        main: hardMain(key),
        shift: sparse
          ? key.variant === 'num' || (key.variant === 'letter' && plus2KeepsRed(key.red))
            ? key.red
            : undefined
          : key.red,
        aux: sparse
          ? key.main ? PLUS2_KEYWORDS[key.main] : undefined
          : compactLegend([key.color, key.ext, key.green, key.ess, key.word]),
      },
      tone: 'dark',
      region: key.variant,
      shape: key.variant === 'enter' ? 'return' : 'rectangle',
      clipPath: key.variant === 'enter' ? hardEnterClip(sparse) : undefined,
    })),
  };
}

export function spectrumKeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return [
    rubberDocument(),
    hardDocument('spectrum-128k', 'ZX Spectrum 128K', false, 'spectrum128'),
    hardDocument('spectrum-plus2', 'ZX Spectrum +2', true, 'spectrum-plus2'),
    hardDocument('spectrum-plus2a', 'ZX Spectrum +2A', true, 'spectrum-amstrad'),
    hardDocument('spectrum-plus3', 'ZX Spectrum +3', true, 'spectrum-amstrad'),
  ];
}
