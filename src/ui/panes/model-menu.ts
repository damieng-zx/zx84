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
  'zx16k': 'ZX Spectrum 16K',
  'zx48k': 'ZX Spectrum 48K',
  'zx128k': 'ZX Spectrum 128K',
  'zx128kplus2': 'ZX Spectrum +2',
  'zx128kplus2a': 'ZX Spectrum +2A',
  'zx128kplus3': 'ZX Spectrum +3',
  pentagon128: 'Pentagon 128',
  pentagon512: 'Pentagon 512',
  pentagon1024: 'Pentagon 1024',
  scorpion256: 'Scorpion ZS-256',
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
  'hb-55': 'Sony HB-55',
  'hb-55p': 'Sony HB-55P',
  mtx500: 'Memotech MTX500',
  mtx512: 'Memotech MTX512',
  rs128: 'Memotech RS128',
  lynx48: 'Camputers Lynx 48K',
  lynx96: 'Camputers Lynx 96K',
  lynx128: 'Camputers Lynx 128K',
  'jupiter-ace': 'Jupiter Ace',
  pcw8256: 'PCW 8256',
  pcw8512: 'PCW 8512',
  pcw9256: 'PCW 9256',
  pcw9512: 'PCW 9512',
  'bbc-b': 'BBC Micro Model B',
  electron: 'Electron',
  apple1: 'Apple I',
  apple2: 'Apple ][',
  'apple2-plus': 'Apple ][+',
  apple2e: 'Apple //e',
  'apple2e-enhanced': 'Apple //e Enhanced',
  apple2c: 'Apple //c',
  ep64: 'Enterprise 64',
  ep128: 'Enterprise 128',
  atari400: 'Atari 400',
  atari800: 'Atari 800',
  atari600xl: 'Atari 600XL',
  atari800xl: 'Atari 800XL',
  atari1200xl: 'Atari 1200XL',
  atari65xe: 'Atari 65XE',
  atari800xe: 'Atari 800XE',
  atari130xe: 'Atari 130XE',
  c64: 'Commodore 64',
  newbrain: 'Grundy NewBrain',
};

export const LOCALE_LABELS: Record<MachineLocale, string> = {
  uk: 'English',
  es: 'Español',
  fr: 'Français',
  us: 'NTSC',
};

/** Models that have locale-specific ROM variants, and which locales. */
export const MODEL_LOCALES: Partial<Record<MachineModel, MachineLocale[]>> = {
  'zx48k': ['es'],
  'zx128k': ['fr', 'es'],
  'zx128kplus2': ['fr', 'es'],
  'zx128kplus2a': ['es'],
  'zx128kplus3': ['es'],
  cpc464: ['fr', 'es'],
  cpc6128: ['fr'],
  // The Atari's locales are TV standards: 'uk' is the PAL machine (50 Hz,
  // 312 lines), 'us' the NTSC one (60 Hz, 262 lines). Both are listed, since
  // neither is a "default" a user would assume from the bare name.
  atari400: ['uk', 'us'],
  atari800: ['uk', 'us'],
  atari600xl: ['uk', 'us'],
  atari800xl: ['uk', 'us'],
  atari1200xl: ['uk', 'us'],
  atari65xe: ['uk', 'us'],
  atari800xe: ['uk', 'us'],
  atari130xe: ['uk', 'us'],
  c64: ['uk', 'us'],
};

/** Models whose locale variants are TV standards rather than languages. */
const TV_STANDARD_MODELS: ReadonlySet<MachineModel> = new Set<MachineModel>([
  'atari400', 'atari800', 'atari600xl', 'atari800xl', 'atari1200xl',
  'atari65xe', 'atari800xe', 'atari130xe', 'c64',
]);
const TV_STANDARD_LABELS: Partial<Record<MachineLocale, string>> = { uk: 'PAL', us: 'NTSC' };

/** Name of `locale` for `model`: 'PAL'/'NTSC' for a TV-standard model,
 *  otherwise the language. */
export function localeLabelFor(model: MachineModel, locale: MachineLocale): string {
  return (TV_STANDARD_MODELS.has(model) ? TV_STANDARD_LABELS[locale] : undefined) ?? LOCALE_LABELS[locale];
}

/** Suffix for the model button, or null when the bare model name says it
 *  all. TV-standard models always show theirs; others only a non-default
 *  locale they actually offer. */
export function modelLocaleSuffix(model: MachineModel, locale: MachineLocale): string | null {
  if (TV_STANDARD_MODELS.has(model)) return localeLabelFor(model, locale === 'us' ? 'us' : 'uk');
  if (locale === 'uk' || !MODEL_LOCALES[model]?.includes(locale)) return null;
  return LOCALE_LABELS[locale];
}

const FLAG_EMOJI: Record<MachineLocale, string> = {
  uk: '🇬🇧',
  es: '🇪🇸',
  fr: '🇫🇷',
  us: '🇺🇸',
};

/** Build a model menu entry. Models with locale variants get flag icons. */
function modelEntry(model: MachineModel): MenuItem {
  const variants = MODEL_LOCALES[model];
  if (!variants) return { value: model, label: MODEL_LABELS[model] };
  return {
    value: model,
    label: MODEL_LABELS[model],
    flags: variants.map(l => ({ locale: localeLabelFor(model, l), emoji: FLAG_EMOJI[l], value: `${model}:${l}` })),
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
      modelEntry('zx16k'),
      modelEntry('zx48k'),
      modelEntry('zx128k'),
      modelEntry('zx128kplus2'),
      modelEntry('zx128kplus2a'),
      modelEntry('zx128kplus3'),
    ],
  },
  {
    value: 'sinclair-clones',
    label: 'Sinclair Clones',
    children: [
      modelEntry('pentagon128'),
      modelEntry('pentagon512'),
      modelEntry('pentagon1024'),
      modelEntry('scorpion256'),
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
      modelEntry('pcw8256'),
      modelEntry('pcw8512'),
      modelEntry('pcw9256'),
      modelEntry('pcw9512'),
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
      modelEntry('hb-55'),
      modelEntry('hb-55p'),
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
    value: 'camputers',
    label: 'Camputers',
    children: [
      modelEntry('lynx48'),
      modelEntry('lynx96'),
      modelEntry('lynx128'),
    ],
  },
  {
    value: 'jupiter',
    label: 'Jupiter Cantab',
    children: [
      modelEntry('jupiter-ace'),
    ],
  },
  {
    value: 'grundy',
    label: 'Grundy',
    children: [
      modelEntry('newbrain'),
    ],
  },
  {
    value: 'acorn',
    label: 'Acorn',
    children: [
      modelEntry('bbc-b'),
      modelEntry('electron'),
    ],
  },
  {
    value: 'apple',
    label: 'Apple',
    children: [
      modelEntry('apple1'),
      modelEntry('apple2'),
      modelEntry('apple2-plus'),
      modelEntry('apple2e'),
      modelEntry('apple2e-enhanced'),
      modelEntry('apple2c'),
    ],
  },
  {
    value: 'enterprise',
    label: 'Enterprise',
    children: [
      modelEntry('ep64'),
      modelEntry('ep128'),
    ],
  },
  {
    value: 'atari',
    label: 'Atari',
    children: [
      modelEntry('atari400'),
      modelEntry('atari800'),
      modelEntry('atari600xl'),
      modelEntry('atari800xl'),
      modelEntry('atari1200xl'),
      modelEntry('atari65xe'),
      modelEntry('atari800xe'),
      modelEntry('atari130xe'),
    ],
  },
  {
    value: 'commodore',
    label: 'Commodore',
    children: [
      modelEntry('c64'),
    ],
  },
];

/** Every model the menu can reach, in menu order. */
export function menuModels(): string[] {
  return MODEL_MENU.flatMap(group => (group.children ?? []).map(item => item.value));
}
