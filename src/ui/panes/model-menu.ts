/**
 * The model picker's contents: every machine the shell can be switched to,
 * grouped by the name on the badge.
 *
 * This lives apart from `HardwarePane` so it can be held against the machine
 * registry by a test. A model that exists but is not in this menu cannot be
 * selected at all, and nothing else would notice — `MODEL_LABELS` is exhaustive
 * over `MachineModel` so the compiler catches a missing *label*, but a missing
 * *menu entry* is invisible until someone goes looking for the machine.
 */

import type { MenuItem } from '@/ui/components/DropDownMenuButton.tsx';
import type { MachineLocale } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';

/** Full name shown on the model box once selected — keyed by model value. */
export const MODEL_LABELS: Record<MachineModel, string> = {
  '16k': 'ZX Spectrum 16K',
  '48k': 'ZX Spectrum 48K',
  '128k': 'ZX Spectrum 128K',
  '+2': 'ZX Spectrum +2',
  '+2A': 'ZX Spectrum +2A',
  '+3': 'ZX Spectrum +3',
  zx80: 'ZX80',
  zx81: 'ZX81',
  cpc464: 'CPC 464',
  cpc664: 'CPC 664',
  cpc6128: 'CPC 6128',
  cpc6128plus: 'CPC 6128 Plus',
  gx4000: 'GX4000',
  'einstein-tc01': 'Einstein TC-01',
  'einstein-256': 'Einstein 256',
  'hx-10': 'Toshiba HX-10',
  mtx500: 'Memotech MTX500',
  mtx512: 'Memotech MTX512',
  rs128: 'Memotech RS128',
  lynx48: 'Camputers Lynx 48K',
  lynx96: 'Camputers Lynx 96K',
  lynx128: 'Camputers Lynx 128K',
  sam256: 'SAM Coupé 256K',
  sam512: 'SAM Coupé 512K',
};

export const LOCALE_LABELS: Record<MachineLocale, string> = {
  uk: 'English',
  es: 'Español',
  fr: 'Français',
};

/** Models that have locale-specific ROM variants, and which locales. */
export const MODEL_LOCALES: Partial<Record<MachineModel, MachineLocale[]>> = {
  '48k': ['es'],
  '128k': ['fr', 'es'],
  '+2': ['fr', 'es'],
  '+2A': ['es'],
  '+3': ['es'],
  cpc464: ['fr', 'es'],
  cpc6128: ['fr'],
};

const FLAG_EMOJI: Record<MachineLocale, string> = {
  uk: '🇬🇧',
  es: '🇪🇸',
  fr: '🇫🇷',
};

/** Build a model menu entry. Models with locale variants get flag icons. */
function modelEntry(model: MachineModel): MenuItem {
  const variants = MODEL_LOCALES[model];
  if (!variants) return { value: model, label: MODEL_LABELS[model] };
  return {
    value: model,
    label: MODEL_LABELS[model],
    flags: variants.map(l => ({ locale: LOCALE_LABELS[l], emoji: FLAG_EMOJI[l], value: `${model}:${l}` })),
  };
}

/** Model menu: every machine, behind a submenu for the make that built it. */
export const MODEL_MENU: MenuItem[] = [
  {
    value: 'sinclair',
    label: 'Sinclair',
    children: [
      modelEntry('zx80'),
      modelEntry('zx81'),
      modelEntry('16k'),
      modelEntry('48k'),
      modelEntry('128k'),
      modelEntry('+2'),
      modelEntry('+2A'),
      modelEntry('+3'),
    ],
  },
  {
    value: 'amstrad',
    label: 'Amstrad',
    children: [
      modelEntry('cpc464'),
      modelEntry('cpc664'),
      modelEntry('cpc6128'),
      modelEntry('cpc6128plus'),
      modelEntry('gx4000'),
    ],
  },
  {
    value: 'tatung',
    label: 'Tatung',
    children: [
      modelEntry('einstein-tc01'),
      modelEntry('einstein-256'),
    ],
  },
  {
    value: 'msx',
    label: 'MSX',
    children: [
      modelEntry('hx-10'),
    ],
  },
  {
    value: 'memotech',
    label: 'Memotech',
    children: [
      modelEntry('mtx500'),
      modelEntry('mtx512'),
      modelEntry('rs128'),
    ],
  },
  {
    value: 'mgt',
    label: 'MGT',
    children: [
      modelEntry('sam256'),
      modelEntry('sam512'),
    ],
  },
  {
    value: 'camputers',
    label: 'Camputers',
    children: [
      modelEntry('lynx48'),
      modelEntry('lynx96'),
      modelEntry('lynx128'),
    ],
  },
];

/** Every model the menu can reach, in menu order. */
export function menuModels(): string[] {
  return MODEL_MENU.flatMap(group => (group.children ?? []).map(item => item.value));
}
