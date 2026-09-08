/**
 * Model-specific CPC key faces. The electrical cells are shared, while the
 * 664 and 6128 changed printed legends and physical key treatments.
 */

import type { CpcKeyDef } from './layout.ts';

export type CpcKeyboardVariant = 'cpc464' | 'cpc664' | 'cpc6128';

const CPC664_BLUE_KEYS = new Set([
  'esc',
  'tab',
  'caps-lock',
  'shift-left',
  'shift-right',
  'ctrl',
  'del',
  'return',
  'cursor-up',
  'cursor-left',
  'cursor-right',
  'cursor-down',
  'numpad-enter',
]);

export function cpcKeyMain(key: CpcKeyDef, variant: CpcKeyboardVariant): string {
  if (variant === 'cpc464') return key.main;
  if (variant === 'cpc6128') {
    if (key.id === 'return') return 'RETURN';
    if (key.id === 'ctrl') return 'CONTROL';
  }
  // Both later machines printed the keypad caps as f0..f9 with no digits, but
  // the dot cap carries a plain full stop; only the 464 had numeric legends.
  if (key.fn && key.id !== 'fdot') return key.fn;
  return key.main;
}

const CLASSIC_BARE_CAPS = new Set(['open-bracket', 'close-bracket']);

/**
 * The 464 and 664 printed their bracket caps bare; the 6128 added the braces.
 */
export function cpcKeyShift(
  key: CpcKeyDef,
  variant: CpcKeyboardVariant,
): string | undefined {
  if (variant !== 'cpc6128' && CLASSIC_BARE_CAPS.has(key.id)) return undefined;
  return key.shift;
}

export function isCpc664BlueKey(key: CpcKeyDef): boolean {
  return CPC664_BLUE_KEYS.has(key.id);
}
