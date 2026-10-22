/**
 * Fixed design-coordinate geometry for the XL keyboards: a 15.5-unit, five-row
 * block (the 400's matrix with wider modifiers on both ends) in a dark bezel.
 *
 *   600XL / 800XL  a silver bar down the bezel's full height on the right,
 *                  cut into 1U flat keys on the block's rows (RESET, OPTION,
 *                  SELECT, START, HELP), named on the bezel beside them, with
 *                  the POWER lamp beside the bar's foot.
 *   1200XL         a silver bar across the whole machine above the block,
 *                  cut into 1U flat keys on the block's grid (RESET, the
 *                  badge, START SELECT OPTION, F1-F4, HELP, inverse, BREAK
 *                  flush with the right-hand modifiers), with the legends and
 *                  the POWER/L1/L2 lamps printed above it.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import { ATARI_XL_KEY_INDEX, type AtariKeyDef } from './layout.ts';

export type AtariXlVariant = 'xl' | '1200xl';

const PITCH = 40;
const GAP = 4;
const ROW_PITCH = 42;
const KEY_HEIGHT = ROW_PITCH - GAP;
/** Case showing around the bezel; the case backdrop bleeds on past it. */
const MARGIN = 10;
const BEZEL = 12;
const DECK_UNITS = 15.5;
const DECK_WIDTH = DECK_UNITS * PITCH - GAP;
const DECK_HEIGHT = 5 * ROW_PITCH - GAP;

export interface PlacedAtariXlKey {
  readonly key: AtariKeyDef;
  readonly box: SceneBox;
}

/** A legend or lamp printed on the case rather than on a key. */
export interface AtariXlCaseMark {
  readonly box: SceneBox;
  /** Printed text; with `lamp` too, the lamp sits centred above it. */
  readonly text?: string;
  /** The inverse-video key's half-filled square, printed instead of text. */
  readonly glyph?: 'inverse';
  readonly lamp?: 'power' | 'l1' | 'l2';
}

export interface AtariXlFace {
  readonly scene: { readonly width: number; readonly height: number; readonly unit: number };
  /** The dark panel the keys sit in. */
  readonly bezel: SceneBox;
  /** The bezel and strip run on past the scene to the case's edges. */
  readonly fullWidth?: boolean;
  /** The well under the main block. */
  readonly well: SceneBox;
  /** The console column behind the flat keys, or the 1200XL's bar the flat
   *  keys are cut from (each key spanning the bar's full height, so the bar
   *  and its keys share one gradient). */
  readonly strip: SceneBox;
  /** The 1200XL's badge on the strip. */
  readonly badge?: SceneBox;
  readonly marks: readonly AtariXlCaseMark[];
  readonly keys: readonly PlacedAtariXlKey[];
}

function key(id: string, box: SceneBox): PlacedAtariXlKey {
  const definition = ATARI_XL_KEY_INDEX.get(id);
  if (!definition) throw new Error(`Unknown Atari XL key: ${id}`);
  return { key: definition, box };
}

const unit = (ids: readonly string[]) => ids.map((id) => [id, 1] as const);

/** The main block at (x, y); only the right-hand ends differ by model. */
function mainBlock(variant: AtariXlVariant, x: number, y: number): PlacedAtariXlKey[] {
  const keys: PlacedAtariXlKey[] = [];
  const row = (index: number, entries: readonly (readonly [string, number])[], start = 0) => {
    let units = start;
    for (const [id, width] of entries) {
      keys.push(key(id, {
        x: x + units * PITCH,
        y: y + index * ROW_PITCH,
        width: width * PITCH - GAP,
        height: KEY_HEIGHT,
      }));
      units += width;
    }
  };
  const xl = variant === 'xl';
  row(0, [
    ['esc', 1.5],
    ...unit(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'less', 'greater']),
    ...(xl ? [['backspace', 1], ['break', 1]] as const : [['backspace', 2]] as const),
  ]);
  row(1, [
    ['tab', 1.75],
    ...unit(['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', 'minus', 'equal']),
    ['return', 1.75],
  ]);
  row(2, [
    ['ctrl', 2],
    ...unit(['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'semicolon', 'plus', 'asterisk']),
    ['caps', 1.5],
  ]);
  row(3, [
    ['shift-left', 2.75],
    ...unit(['z', 'x', 'c', 'v', 'b', 'n', 'm', 'comma', 'period', 'slash']),
    ...(xl ? [['shift-right', 1.75], ['inverse', 1]] as const : [['shift-right', 2.75]] as const),
  ]);
  row(4, [['space', 9]], 3.25);
  return keys;
}

// ── 600XL / 800XL ──────────────────────────────────────────────────────────

const XL_DECK_X = MARGIN + BEZEL;
const XL_DECK_Y = MARGIN + BEZEL;
/** The bezel runs on below the block, beside the bar's foot, where the POWER
 *  lamp sits above its legend. */
const XL_BEZEL_FOOT = 34;
const XL_BEZEL_HEIGHT = BEZEL + DECK_HEIGHT + XL_BEZEL_FOOT;
const XL_BAR_X = XL_DECK_X + DECK_WIDTH + 22;
const XL_BAR_WIDTH = PITCH - GAP;
const XL_LEGEND_X = XL_BAR_X + XL_BAR_WIDTH + 6;
/** Just wide enough for OPTION and SELECT. */
const XL_LEGEND_WIDTH = 34;
const XL_RIGHT = XL_LEGEND_X + XL_LEGEND_WIDTH;

function xlFace(): AtariXlFace {
  const keys = mainBlock('xl', XL_DECK_X, XL_DECK_Y);
  const marks: AtariXlCaseMark[] = [];
  // The console keys are cut from the bar, one per row of the block: each
  // spans the bar's width and a whole row pitch, so the cuts fall where the
  // block's row gaps do.
  (['reset', 'option', 'select', 'start', 'help'] as const).forEach((id, index) => {
    const y = XL_DECK_Y + index * ROW_PITCH;
    keys.push(key(id, { x: XL_BAR_X, y: y - GAP / 2, width: XL_BAR_WIDTH, height: ROW_PITCH }));
    marks.push({
      box: { x: XL_LEGEND_X, y, width: XL_LEGEND_WIDTH, height: KEY_HEIGHT },
      text: ATARI_XL_KEY_INDEX.get(id)!.main,
    });
  });
  // The POWER lamp beside the bar's foot, above its legend.
  marks.push({
    box: { x: XL_LEGEND_X, y: XL_DECK_Y + DECK_HEIGHT + 4, width: XL_LEGEND_WIDTH, height: 26 },
    lamp: 'power',
    text: 'POWER',
  });

  return {
    scene: { width: XL_RIGHT + BEZEL + MARGIN, height: MARGIN + XL_BEZEL_HEIGHT + MARGIN, unit: 1 },
    bezel: { x: MARGIN, y: MARGIN, width: XL_RIGHT + BEZEL - MARGIN, height: XL_BEZEL_HEIGHT },
    well: { x: XL_DECK_X - 6, y: XL_DECK_Y - 6, width: DECK_WIDTH + 12, height: DECK_HEIGHT + 12 },
    // The silver bar, the bezel's full height.
    strip: { x: XL_BAR_X, y: MARGIN, width: XL_BAR_WIDTH, height: XL_BEZEL_HEIGHT },
    marks,
    keys,
  };
}

// ── 1200XL ─────────────────────────────────────────────────────────────────

const STRIP_KEY_HEIGHT = 26;
const STRIP_LEGEND_HEIGHT = 14;
const STRIP_LEGEND_Y = MARGIN + 8;
const STRIP_Y = STRIP_LEGEND_Y + STRIP_LEGEND_HEIGHT + 4;
const XL1200_DECK_X = MARGIN + BEZEL;
const XL1200_DECK_Y = STRIP_Y + STRIP_KEY_HEIGHT + 16;
/** Keys on the bar: RESET, then ten from START to BREAK; the badge takes the
 *  rest of the block's width between them. */
const STRIP_RIGHT_KEYS = 10;
const BADGE_UNITS = DECK_UNITS - 1 - STRIP_RIGHT_KEYS;

function xl1200Face(): AtariXlFace {
  const keys = mainBlock('1200xl', XL1200_DECK_X, XL1200_DECK_Y);
  const marks: AtariXlCaseMark[] = [];
  const at = (units: number) => XL1200_DECK_X + units * PITCH;
  // A bar key is a whole pitch wide, centred on its grid gap, so the cuts
  // between keys fall where the gaps in the block below do.
  const flat = (id: string, units: number, legend: string | { glyph: 'inverse' }) => {
    const x = at(units);
    keys.push(key(id, { x: x - GAP / 2, y: STRIP_Y, width: PITCH, height: STRIP_KEY_HEIGHT }));
    marks.push({
      box: { x, y: STRIP_LEGEND_Y, width: PITCH - GAP, height: STRIP_LEGEND_HEIGHT },
      ...(typeof legend === 'string' ? { text: legend } : legend),
    });
  };

  flat('reset', 0, 'RESET');
  // The badge, with the three lamps printed above it.
  const badgeX = at(1);
  const badgeWidth = BADGE_UNITS * PITCH - GAP;
  const badge = { x: badgeX - GAP / 2, y: STRIP_Y, width: badgeWidth + GAP, height: STRIP_KEY_HEIGHT };
  const lampWidth = badgeWidth / 3;
  (['power', 'l1', 'l2'] as const).forEach((lamp, index) => {
    const left = badgeX + index * lampWidth;
    marks.push({
      box: { x: left + 4, y: STRIP_LEGEND_Y + 2, width: 10, height: 10 },
      lamp,
    });
    marks.push({
      box: { x: left + 16, y: STRIP_LEGEND_Y, width: lampWidth - 18, height: STRIP_LEGEND_HEIGHT },
      text: lamp === 'power' ? 'POWER' : lamp.toUpperCase(),
    });
  });
  const right: readonly (readonly [string, string | { glyph: 'inverse' }])[] = [
    ['start', 'START'], ['select', 'SELECT'], ['option', 'OPTION'],
    ['f1', 'F1'], ['f2', 'F2'], ['f3', 'F3'], ['f4', 'F4'],
    ['help', 'HELP'], ['strip-inverse', { glyph: 'inverse' }], ['strip-break', 'BREAK'],
  ];
  right.forEach(([id, legend], index) => flat(id, 1 + BADGE_UNITS + index, legend));

  const width = XL1200_DECK_X + DECK_WIDTH + BEZEL + MARGIN;
  return {
    scene: { width, height: XL1200_DECK_Y + DECK_HEIGHT + BEZEL + MARGIN, unit: 1 },
    bezel: { x: 0, y: MARGIN, width, height: XL1200_DECK_Y + DECK_HEIGHT + BEZEL - MARGIN },
    fullWidth: true,
    well: {
      x: XL1200_DECK_X - 6,
      y: XL1200_DECK_Y - 6,
      width: DECK_WIDTH + 12,
      height: DECK_HEIGHT + 12,
    },
    strip: { x: 0, y: STRIP_Y, width, height: STRIP_KEY_HEIGHT },
    badge,
    marks,
    keys,
  };
}

export const ATARI_XL_FACES: Readonly<Record<AtariXlVariant, AtariXlFace>> = {
  xl: xlFace(),
  '1200xl': xl1200Face(),
};
