/**
 * Model-specific CPC key faces. The electrical cells are shared, while the
 * 664 changed the printed RETURN legend and its blue control-key set.
 */

import type { CpcKeyDef } from './layout.ts';

export type CpcKeyboardVariant = 'cpc464' | 'cpc664';

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
  return variant === 'cpc664' && key.id === 'return' ? 'RETURN' : key.main;
}

export function isCpc664BlueKey(key: CpcKeyDef): boolean {
  return CPC664_BLUE_KEYS.has(key.id);
}
