/**
 * Fixed design-coordinate geometry for the three Apple II keyboards, on a 40-unit
 * key pitch with 36-unit caps.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import {
  apple2Keys,
  type Apple2KeyboardVariant,
  type Apple2KeyDef,
} from './layout.ts';

export interface Apple2Scene {
  readonly width: number;
  readonly height: number;
  readonly unit: number;
}

export interface PlacedApple2Key {
  readonly key: Apple2KeyDef;
  readonly box: SceneBox;
}

const PITCH = 40;
const CAP = 36;

class Placer {
  readonly placed: PlacedApple2Key[] = [];
  private readonly index: Map<string, Apple2KeyDef>;

  constructor(variant: Apple2KeyboardVariant) {
    this.index = new Map(apple2Keys(variant).map((key) => [key.id, key] as const));
  }

  put(id: string, x: number, y: number, width = CAP, height = CAP): void {
    const key = this.index.get(id);
    if (!key) throw new Error(`Unknown Apple II key: ${id}`);
    this.placed.push({ key, box: { x, y, width, height } });
  }

  /** A run of standard caps at the key pitch. */
  run(ids: readonly string[], x: number, y: number): void {
    ids.forEach((id, i) => this.put(id, x + i * PITCH, y));
  }

  /** Every key placed exactly once. */
  done(): readonly PlacedApple2Key[] {
    if (this.placed.length !== this.index.size) {
      const seen = new Set(this.placed.map((p) => p.key.id));
      const missing = [...this.index.keys()].filter((id) => !seen.has(id));
      throw new Error(`Apple II keys not placed: ${missing.join(', ')}`);
    }
    return this.placed;
  }
}

const keyIds = (row: string) => [...row].map((ch) => `Key${ch}`);
const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];

// ── Apple ][ / ][+ ─────────────────────────────────────────────────────────

export const APPLE2_SCENE: Apple2Scene = { width: 576, height: 240, unit: 1 };

/** The ][ POWER lamp: a lit lens set in the bottom-left key position. */
export const APPLE2_POWER_LAMP: SceneBox = { x: 10, y: 186, width: CAP, height: CAP };

function placeApple2(): readonly PlacedApple2Key[] {
  const p = new Placer('apple2');
  const [r1, r2, r3, r4, r5] = [18, 60, 102, 144, 186];
  p.run([...DIGITS, 'colon', 'Minus', 'reset'], 40, r1);
  p.put('Escape', 20, r2);
  p.run([...keyIds('QWERTYUIOP'), 'rept'], 60, r2);
  p.put('Enter', 500, r2, 56);
  p.put('ctrl', 10, r3, 56);
  p.run([...keyIds('ASDFGHJKL'), 'Semicolon', 'ArrowLeft', 'ArrowRight'], 70, r3);
  p.put('shift-left', 10, r4, 76);
  p.run([...keyIds('ZXCVBNM'), 'Comma', 'Period', 'Slash'], 90, r4);
  p.put('shift-right', 490, r4, 66);
  p.put('Space', 130, r5, 316);
  return p.done();
}

// ── Apple //e and //c ─────────────────────────────────────────────────────

export const APPLE2E_SCENE: Apple2Scene = { width: 596, height: 264, unit: 1 };

const IIE_ROWS = [46, 88, 130, 172, 214] as const;
/** The short, recessed caps of the top strip (RESET and the //c switches). */
const STRIP_Y = 10;
const STRIP_H = 26;

/** The //e POWER lamp, a lens in the bottom row between ` and Open-Apple. */
export const APPLE2E_POWER_LAMP: SceneBox = { x: 110, y: IIE_ROWS[4], width: CAP, height: CAP };

/** The //c's top strip: its two latching switches and the two lamps. */
export const APPLE2C_SWITCHES: readonly { box: SceneBox; label: string }[] = [
  { box: { x: 70, y: STRIP_Y, width: CAP, height: STRIP_H }, label: '80/40' },
  { box: { x: 112, y: STRIP_Y, width: CAP + 20, height: STRIP_H }, label: 'keyboard' },
];
export const APPLE2C_LAMPS: readonly { box: SceneBox; label: string; kind: 'power' | 'disk' }[] = [
  { box: { x: 470, y: STRIP_Y, width: 50, height: STRIP_H }, label: 'power', kind: 'power' },
  { box: { x: 530, y: STRIP_Y, width: 56, height: STRIP_H }, label: 'disk use', kind: 'disk' },
];

function placeIieBlock(p: Placer, iic: boolean): void {
  const [r1, r2, r3, r4, r5] = IIE_ROWS;
  p.put('Escape', 10, r1);
  p.run([...DIGITS, 'Minus', 'Equal'], 50, r1);
  p.put('Delete', 530, r1, 56);
  p.put('Tab', 10, r2, 56);
  p.run([...keyIds('QWERTYUIOP'), 'BracketLeft', 'BracketRight', 'Backslash'], 70, r2);
  p.put('ctrl', 10, r3, 66);
  p.run([...keyIds('ASDFGHJKL'), 'Semicolon', 'Quote'], 80, r3);
  p.put('Enter', 520, r3, 66);
  p.put('shift-left', 10, r4, 86);
  p.run([...keyIds('ZXCVBNM'), 'Comma', 'Period', 'Slash'], 100, r4);
  p.put('shift-right', 500, r4, 86);
  p.put('caps-lock', 10, r5, 56);
  p.put('Backquote', 70, r5);
  // The //e gives a cap position to its POWER lamp; the //c's lamps are up top.
  const appleX = iic ? 110 : 150;
  p.put('open-apple', appleX, r5);
  p.put('Space', appleX + PITCH, r5, 386 - (appleX + PITCH));
  p.run(['solid-apple', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp'], 390, r5);
}

function placeApple2e(): readonly PlacedApple2Key[] {
  const p = new Placer('apple2e');
  p.put('reset', 540, STRIP_Y, 46, STRIP_H);
  placeIieBlock(p, false);
  return p.done();
}

function placeApple2c(): readonly PlacedApple2Key[] {
  const p = new Placer('apple2c');
  p.put('reset', 10, STRIP_Y, 46, STRIP_H);
  placeIieBlock(p, true);
  return p.done();
}

const PLACED: Record<Apple2KeyboardVariant, readonly PlacedApple2Key[]> = {
  apple2: placeApple2(),
  apple2e: placeApple2e(),
  apple2c: placeApple2c(),
};

export function apple2Scene(variant: Apple2KeyboardVariant): Apple2Scene {
  return variant === 'apple2' ? APPLE2_SCENE : APPLE2E_SCENE;
}

export function placeApple2Keys(variant: Apple2KeyboardVariant): readonly PlacedApple2Key[] {
  return PLACED[variant];
}
