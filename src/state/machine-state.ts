/**
 * Machine State - core machine lifecycle signals.
 *
 * These signals control the fundamental machine state:
 * - Model selection (48K, 128K, etc.)
 * - ROM status
 * - Emulation pause/turbo
 * - Status messages
 */

import { createSignal } from 'solid-js';
import type { MachineModel } from '@/models.ts';
import type { MachineLocale, RomSlotInfo } from '@/machines/machine.ts';

const KNOWN_MODELS: readonly MachineModel[] = [
  '16k', '48k', '128k', '+2', '+2A', '+3',
  'cpc6128', 'cpc464', 'cpc664', 'cpc6128plus', 'gx4000',
  'einstein-tc01', 'einstein-256',
  'hx-10',
  'mtx500', 'mtx512', 'rs128',
  'zx80', 'zx81',
];

export function isKnownModel(value: string): value is MachineModel {
  return (KNOWN_MODELS as readonly string[]).includes(value);
}

function loadSavedModel(): MachineModel | null {
  try {
    const raw = localStorage.getItem('zx84-model');
    if (raw === null) return null;
    // Legacy migrations: pre-2026-05 builds stored '+2a' lower-case, and the
    // Einstein TC-01 was 'einstein' before it was renamed 'einstein-tc01'.
    const val = raw === '+2a' ? '+2A' : raw === 'einstein' ? 'einstein-tc01' : raw;
    if (isKnownModel(val)) {
      if (val !== raw) {
        try { localStorage.setItem('zx84-model', val); } catch { /* */ }
      }
      return val as MachineModel;
    }
    // Unknown value — drop it so the next boot starts clean instead of carrying
    // a corrupted entry forever.
    try { localStorage.removeItem('zx84-model'); } catch { /* */ }
  } catch { /* */ }
  return null;
}

export function saveModel(model: MachineModel): void {
  try {
    localStorage.setItem('zx84-model', model);
  } catch { /* */ }
}

// Status messages
const _statusText = createSignal('Load a ROM to start');
export const statusText = _statusText[0];
export const setStatusText = _statusText[1];

const _romStatusText = createSignal('');
export const romStatusText = _romStatusText[0];
export const setRomStatusText = _romStatusText[1];

// System ROM slots — the single source for the ROM pane, populated from
// machine.services.roms.systemSlots after each build / ROM mutation. One entry
// per socket (single-ROM models = 1; 128K/+2 = 2; +2A/+3 = 4).
const _romSlots = createSignal<readonly RomSlotInfo[]>([]);
export const romSlots = _romSlots[0];
export const setRomSlots = _romSlots[1];

// Name of the mounted cartridge (empty = none), for the ROM pane.
const _cartridgeName = createSignal('');
export const cartridgeName = _cartridgeName[0];
export const setCartridgeName = _cartridgeName[1];

// Model selection
const _currentModel = createSignal<MachineModel>(loadSavedModel() ?? '128k');
export const currentModel = _currentModel[0];
export const setCurrentModel = _currentModel[1];

// Locale selection (keyboard / ROM region)
function loadSavedLocale(): MachineLocale {
  try {
    const raw = localStorage.getItem('zx84-locale');
    if (raw === 'es' || raw === 'fr') return raw;
  } catch { /* */ }
  return 'uk';
}

function saveLocale(locale: MachineLocale): void {
  try { localStorage.setItem('zx84-locale', locale); } catch { /* */ }
}

const _currentLocale = createSignal<MachineLocale>(loadSavedLocale());
export const currentLocale = _currentLocale[0];
export const setCurrentLocale = (locale: MachineLocale): void => {
  _currentLocale[1](locale);
  saveLocale(locale);
};

// Execution control
const _emulationPaused = createSignal(false);
export const emulationPaused = _emulationPaused[0];
export const setEmulationPaused = _emulationPaused[1];

const _turboMode = createSignal(false);
export const turboMode = _turboMode[0];
export const setTurboMode = _turboMode[1];

// Index into the discrete speed stops exposed by the Hardware pane.
const _speedStep = createSignal(4);
export const speedStep = _speedStep[0];
export const setSpeedStep = _speedStep[1];

// Speed display — holds just the numeric value; the "MHz" unit is rendered
// separately (smaller) in the UI. Empty until the first sample arrives.
const _clockSpeedText = createSignal('');
export const clockSpeedText = _clockSpeedText[0];
export const setClockSpeedText = _clockSpeedText[1];

// Peripheral ROM load failures (empty string = OK, non-empty = error reason)
const _multifaceRomFailed = createSignal('');
export const multifaceRomFailed = _multifaceRomFailed[0];
export const setMultifaceRomFailed = _multifaceRomFailed[1];

const _vtx5000RomFailed = createSignal('');
export const vtx5000RomFailed = _vtx5000RomFailed[0];
export const setVtx5000RomFailed = _vtx5000RomFailed[1];

const _paradosRomFailed = createSignal('');
export const paradosRomFailed = _paradosRomFailed[0];
export const setParadosRomFailed = _paradosRomFailed[1];

const _plusDRomFailed = createSignal('');
export const plusDRomFailed = _plusDRomFailed[0];
export const setPlusDRomFailed = _plusDRomFailed[1];

const _interface1RomFailed = createSignal('');
export const interface1RomFailed = _interface1RomFailed[0];
export const setInterface1RomFailed = _interface1RomFailed[1];

const _betaDiskRomFailed = createSignal('');
export const betaDiskRomFailed = _betaDiskRomFailed[0];
export const setBetaDiskRomFailed = _betaDiskRomFailed[1];
