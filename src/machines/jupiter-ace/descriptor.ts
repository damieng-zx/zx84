/**
 * Jupiter Ace registry entry — pure metadata + factory.
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type { MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { JupiterAceModel } from './models.ts';
import { JupiterAceMachine } from './ace-machine.ts';
import {
  ACE_SCREEN_WIDTH, ACE_SCREEN_HEIGHT, ACE_BORDER_LEFT, ACE_BORDER_TOP,
} from './constants.ts';

const ACE_UI: MachineUiCapabilities = {
  // The Ace has no disk, microdrive, joystick, mouse or character-font ROM:
  // those panes would render empty. No snapshot format exists either, so the
  // save menu carries only the always-available entries.
  hiddenPanes: [
    'drive-panel', 'microdrive-panel', 'joystick-panel', 'mouse-panel',
    'font-panel', 'sysvar-panel', 'banks-panel',
  ],
  memoryLayout: false,
  trace: true,
  colorMap: 'mono',
  accuracy: false,
  builtinDisk: false,
  joystick: false,
  fixedJoystick: false,
  mouseTypes: [],
  cartridge: false,
  systemRomLabel: 'ROM',
  romPages: 0,
  // The Ace's only sound is the ULA buzzer (the keypress beep).
  beeper: true,
  psgControls: [],
  // Buzzer, keyboard and the cassette port have activity to show. No OCR
  // overlay yet, so no 'text' LED.
  statusLeds: ['kbd', 'ear', 'load', 'beep'],
  keyboardBus: 'ula',
  tape: 'deck',
  // EAR input is not wired to the buzzer — the tape is silent while loading.
  tapeSound: false,
  tapeExtensions: ['.tap', '.tzx', '.csw', '.zip'],
  saveMenu: ['screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: true,
  bootDisk: false,
  library: false,
  memoryRegions: [
    { value: 'rom0', label: 'ROM' },
    { value: 'vram', label: 'Video RAM' },
    { value: 'charram', label: 'Char RAM' },
    { value: 'ram', label: 'Main RAM' },
    { value: 'expansion', label: 'RAM pack' },
  ],
  charset: 'spectrum',
};

/** Descriptor for the Jupiter Ace — shared by the registry entry and the
 *  machine instance's own `descriptor` getter. */
export function aceDescriptor(model: MachineModel, locale: MachineLocale = 'uk'): MachineDescriptor {
  return {
    kind: 'jupiter-ace',
    model,
    locale,
    cpuFamily: 'z80',
    screen: {
      width: ACE_SCREEN_WIDTH, height: ACE_SCREEN_HEIGHT, pixelAspectX: 1,
      activeWidth: 256, activeHeight: 192,
      borderLeft: ACE_BORDER_LEFT, borderTop: ACE_BORDER_TOP,
    },
    ui: ACE_UI,
  };
}

const ACE_ROM = 'jupiter/ace.rom';

export const aceEntry: MachineEntry = {
  kind: 'jupiter-ace',
  models: ['jupiter-ace'],
  descriptor: aceDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new JupiterAceMachine(model as JupiterAceModel, display);
  },
  romSources(_model?: MachineModel, _locale?: MachineLocale) {
    return [ACE_ROM];
  },
  /** ROM-size → Ace model. An 8KB blob is far too generic a size to hijack
   *  from another family (the Einstein/SAM convention), so a raw drop only
   *  re-classifies when the Ace is already active. */
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    if (current !== 'jupiter-ace') return null;
    if (data.length === 0x2000 || data.length === 0x1000) return current;
    return null;
  },
};
