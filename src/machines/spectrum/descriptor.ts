/**
 * Spectrum registry entry — pure metadata + factory (re-architecture §3.5).
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type { MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities, MemoryRegionInfo } from '@/machines/machine.ts';
import type { StatusLedId } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { isCpcModel } from '@/models.ts';
import type { SpectrumModel } from './models.ts';
import { is128kClass, isPlus2AClass, isPlus3, isInterface2Capable, romPageSlotCount } from './models.ts';
import { Spectrum } from './spectrum.ts';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './ula.ts';

// The Spectrum active display is 256×192; the full ("Normal") border is 48px on
// every side (SCREEN_WIDTH/HEIGHT = 256/192 + 48·2). The border-size crop is
// applied generically by Screen.tsx.
const SPECTRUM_BORDER = 48;

/** ROM regions the Memory pane offers: one entry per 16K system-ROM page. */
function spectrumMemoryRegions(model: MachineModel): MemoryRegionInfo[] {
  const romCount = isPlus2AClass(model) ? 4 : is128kClass(model) ? 2 : 1;
  return Array.from({ length: romCount }, (_, i) => ({ value: `rom${i}`, label: `ROM ${i}` }));
}

function spectrumStatusLeds(model: MachineModel): StatusLedId[] {
  const leds: StatusLedId[] = ['kbd', 'kemp', 'mouse', 'ear', 'load', 'text', 'rainbow', 'beep'];
  if (is128kClass(model)) leds.push('ay');
  if (isPlus3(model)) leds.push('dsk');
  return leds;
}

function spectrumUi(model: MachineModel): MachineUiCapabilities {
  return {
    hiddenPanes: [],
    memoryLayout: is128kClass(model),
    trace: true,
    colorMap: 'spectrum',
    accuracy: true,
    builtinDisk: isPlus3(model),
    joystick: true,
    fixedJoystick: false,
    mouse: true,
    cartridge: isInterface2Capable(model),
    systemRomLabel: 'ROM',
    romPages: romPageSlotCount(model),
    beeper: true,
    statusLeds: spectrumStatusLeds(model),
    keyboardBus: 'ula',
    tape: 'deck',
    tapeSound: true,
    tapeExtensions: ['.tap', '.tzx', '.csw', '.zip'],
    saveMenu: 'spectrum',
    zipPolicy: 'all',
    persistMedia: true,
    bootDisk: false,
    library: true,
    memoryRegions: spectrumMemoryRegions(model),
    charset: 'spectrum',
  };
}

/** Build a ROM lookup key from model + locale. Returns just the model for 'uk'
 *  (the default, matching existing CDN paths with no locale suffix). */
function romKey(model: SpectrumModel, locale?: MachineLocale): string {
  return locale && locale !== 'uk' ? `${model}-${locale}` : model;
}

// Each model lists its ROM pages in order; they are fetched and concatenated
// by the shared rom-manager machinery. The +3 is resolved to the +2A's v4.1
// set by the shell's effectiveROMModel() before lookup, but keep its own row
// so the table is total over the family.
//
// International variants: 'es' = Spanish (Investrónica), 'fr' = French.
// Keyed by model (UK) or `${model}-${locale}` for non-UK variants.
// Falls back to UK when a locale ROM is not registered.
const ROM_SOURCES: Record<string, string[]> = {
  // ── UK defaults ──────────────────────────────────────────────────────────
  '16k':  ['sinclair/48.rom'],
  '48k':  ['sinclair/48.rom'],
  '128k': ['sinclair/128-0.rom', 'sinclair/128-1.rom'],
  '+2':   ['sinclair/plus2-0.rom', 'sinclair/plus2-1.rom'],
  '+2A':  ['sinclair/plus3-41-0.rom', 'sinclair/plus3-41-1.rom', 'sinclair/plus3-41-2.rom', 'sinclair/plus3-41-3.rom'],
  '+3':   ['sinclair/plus3-0.rom', 'sinclair/plus3-1.rom', 'sinclair/plus3-2.rom', 'sinclair/plus3-3.rom'],

  // ── Spanish (Investrónica) ───────────────────────────────────────────────
  '48k-es':  ['sinclair/48-es.rom'],
  '128k-es': ['sinclair/128-0-es.rom', 'sinclair/128-1-es.rom'],
  '+2-es':   ['sinclair/plus2-0-es.rom', 'sinclair/plus2-1-es.rom'],
  '+2A-es':  ['sinclair/plus3-0-es.rom', 'sinclair/plus3-1-es.rom', 'sinclair/plus3-2-es.rom', 'sinclair/plus3-3-es.rom'],
  '+3-es':   ['sinclair/plus3-0-es.rom', 'sinclair/plus3-1-es.rom', 'sinclair/plus3-2-es.rom', 'sinclair/plus3-3-es.rom'],

  // ── French ───────────────────────────────────────────────────────────────
  '128k-fr': ['sinclair/128-0-fr.rom', 'sinclair/128-1-fr.rom'],
  '+2-fr':   ['sinclair/plus2-0-fr.rom', 'sinclair/plus2-1-fr.rom'],
};

/** Descriptor for one Spectrum model — shared by the registry entry and the
 *  machine instance's own `descriptor` getter. */
export function spectrumDescriptor(model: MachineModel, locale: MachineLocale = 'uk'): MachineDescriptor {
  return {
    kind: 'spectrum',
    model,
    locale,
    cpuFamily: 'z80',
    screen: {
      width: SCREEN_WIDTH, height: SCREEN_HEIGHT, pixelAspectX: 1,
      activeWidth: 256, activeHeight: 192,
      borderLeft: SPECTRUM_BORDER, borderTop: SPECTRUM_BORDER,
    },
    ui: spectrumUi(model),
  };
}

export const spectrumEntry: MachineEntry = {
  kind: 'spectrum',
  models: ['16k', '48k', '128k', '+2', '+2A', '+3'],
  descriptor: spectrumDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new Spectrum(model as SpectrumModel, display);
  },
  romSources(model: MachineModel, locale?: MachineLocale) {
    const sm = model as SpectrumModel;
    const key = romKey(sm, locale);
    return ROM_SOURCES[key] ?? ROM_SOURCES[sm];
  },
  /** ROM-size → Spectrum model: a raw image always lands on a Spectrum (a CPC
   *  falls back to a 128K base), keeping the current model when its class
   *  already matches the image size. Ported verbatim from the shell's applyROM. */
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    const cur: SpectrumModel = isCpcModel(current) ? '128k' : current as SpectrumModel;
    if (data.length >= 65536) return isPlus2AClass(cur) ? cur : '+2A';
    if (data.length >= 32768) return is128kClass(cur) ? cur : '128k';
    if (data.length >= 16384) return '48k';
    return null;   // too small to be a system ROM
  },
};
