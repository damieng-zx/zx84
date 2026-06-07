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

const KNOWN_MODELS: readonly MachineModel[] = [
  '16k', '48k', '128k', '+2', '+2A', '+3',
  'cpc6128', 'cpc464', 'cpc664',
];

function loadSavedModel(): MachineModel | null {
  try {
    const raw = localStorage.getItem('zx84-model');
    if (raw === null) return null;
    // Legacy: pre-2026-05 builds stored '+2a' lower-case. Migrate transparently.
    const val = raw === '+2a' ? '+2A' : raw;
    if ((KNOWN_MODELS as readonly string[]).includes(val)) {
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

// Model selection
const _currentModel = createSignal<MachineModel>(loadSavedModel() ?? '128k');
export const currentModel = _currentModel[0];
export const setCurrentModel = _currentModel[1];

// Execution control
const _emulationPaused = createSignal(false);
export const emulationPaused = _emulationPaused[0];
export const setEmulationPaused = _emulationPaused[1];

const _turboMode = createSignal(false);
export const turboMode = _turboMode[0];
export const setTurboMode = _turboMode[1];

// Speed display
const _clockSpeedText = createSignal('MHz');
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
