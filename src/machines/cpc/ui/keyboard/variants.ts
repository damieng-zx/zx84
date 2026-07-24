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
  if (variant === 'cpc664' && key.id === 'return') return 'RETURN';
  if (variant === 'cpc6128') {
    if (key.id === 'return') return 'RETURN';
    if (key.id === 'ctrl') return 'CONTROL';
    if (key.fn) return key.fn;
  }
  return key.main;
}

export function isCpc664BlueKey(key: CpcKeyDef): boolean {
  return CPC664_BLUE_KEYS.has(key.id);
}
