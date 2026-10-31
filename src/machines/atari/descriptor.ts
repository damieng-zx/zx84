/**
 * Atari 400/800/XL descriptor — pure metadata plus the machine factory.
 *
 * The machines differ in RAM, OS ROM and where BASIC lives (see models.ts).
 * The region is a separate axis (identical logic, different crystal and TV
 * standard) carried by the locale: `'us'` is NTSC, the default PAL.
 *
 * The firmware is the open-source AltirraOS and Altirra BASIC (see
 * models.ts); none of Atari's own images are fetched. On the 400, 800 and
 * 1200XL BASIC is a cartridge, not firmware: `bootCartridge` lets the shell
 * hidden-mount `atari/altirra-basic.rom` when the slot is empty, exactly as it
 * does for the CPC Plus. The 600XL and 800XL have it in ROM, so their system
 * image is the OS followed by BASIC.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { AtariMachine } from './atari-machine.ts';
import { ATARI_DRIVE_MODELS, ATARI_MAX_DRIVES, DEFAULT_DRIVE_MODELS } from './drive-models.ts';
import {
  ATARI_ACTIVE_HEIGHT, ATARI_ACTIVE_WIDTH, ATARI_BORDER_LEFT, ATARI_BORDER_TOP,
  ATARI_PIXEL_ASPECT_X, ATARI_SCREEN_HEIGHT, ATARI_SCREEN_WIDTH,
} from './constants.ts';
import {
  ALTIRRA_BASIC_SOURCE, ATARI_MODELS, ATARI_OS_SIZE, ATARI_XL_OS_SIZE, atariInfo,
  atariRegionForLocale, isAtariModel, type AtariModel,
} from './models.ts';
import { atariPaletteOptions } from './palette.ts';

/**
 * The panes the Atari has no hardware for: the mouse, Sinclair sysvars and
 * Spectrum font hunt never apply. The Banks pane stays: the memory map is
 * real. So do the BASIC panes, which read Atari BASIC's tables.
 */
const HIDDEN = [
  'microdrive-panel', 'mouse-panel',
  'sysvar-panel', 'font-panel',
];

const BASE_UI: MachineUiCapabilities = {
  hiddenPanes: HIDDEN,
  memoryLayout: true,
  trace: true,
  traceModes: ['full', 'portio'],
  colorMap: 'atari',
  accuracy: false,
  builtinDisk: true,
  // Up to four drives on the SIO bus, each with its own model; the default
  // is two (see drive-models.ts).
  builtinDrives: ATARI_MAX_DRIVES,
  builtinDriveLabels: ['D1:', 'D2:', 'D3:', 'D4:'],
  driveModels: ATARI_DRIVE_MODELS,
  defaultDriveModels: DEFAULT_DRIVE_MODELS,
  joystick: true,
  // Two CX40 ports wired straight to PIA port A and GTIA's triggers: no
  // interface to choose, and one fire button.
  fixedJoystick: true,
  joystickFireButtons: 1,
  mouseTypes: [],
  cartridge: true,
  systemRomLabel: 'OS ROM',
  // The OS and BASIC are the two sockets the service lists (see services/roms.ts).
  systemRomSlot: false,
  romPages: 0,
  // GTIA's CONSOL bit 3 drives the 400/800's internal speaker (the XL's goes
  // to the TV sound through POKEY): the BEEP LED, with POKEY on the sound-chip
  // side. Each has its own Sound-pane volume.
  beeper: true,
  soundChip: 'POKEY',
  soundDevices: [
    { id: 'beeper', label: 'Speaker', volumeSetting: 'beeper-volume' },
    { id: 'psg', label: 'POKEY', volumeSetting: 'psg-volume' },
  ],
  psgControls: [],
  statusLeds: ['kbd', 'load', 'dsk', 'chip', 'beep', 'text'],
  keyboardBus: 'matrix',
  // The 410/1010 program recorder, as an instant-load cassette over SIO.
  tape: 'instant',
  tapeSound: false,
  tapeExtensions: ['.cas', '.zip'],
  // 'tape-tap' downloads what the OS has saved to cassette (as .cas).
  saveMenu: ['snapshot-a8state', 'tape-tap', 'screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: true,
  bootDisk: false,
  bootCartridge: true,
  library: false,
  memoryRegions: [
    { value: 'rom-os', label: 'OS ROM' },
    { value: 'rom-fp', label: 'Floating-point ROM' },
  ],
  charset: 'spectrum',
};

const XL_MEMORY_REGIONS = [
  { value: 'rom-os-c000', label: 'OS ROM ($C000)' },
  { value: 'rom-self-test', label: 'Self-test ROM' },
];

function uiFor(model: AtariModel, pal: boolean): MachineUiCapabilities {
  const info = atariInfo(model);
  // The palettes are the region's: NTSC and PAL GTIAs encode colour
  // differently (see palette.ts).
  const base = { ...BASE_UI, colorMapOptions: atariPaletteOptions(pal) };
  if (!info.xl) return base;
  return {
    ...base,
    bootCartridge: !info.builtinBasic,
    memoryRegions: [
      ...BASE_UI.memoryRegions,
      ...XL_MEMORY_REGIONS,
      ...(info.builtinBasic ? [{ value: 'rom-basic', label: 'BASIC ROM' }] : []),
    ],
  };
}

export function atariDescriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  return {
    kind: 'atari',
    model,
    locale,
    cpuFamily: 'm6502',
    screen: {
      width: ATARI_SCREEN_WIDTH,
      height: ATARI_SCREEN_HEIGHT,
      // A 320x192 playfield on a 4:3 television: pixels are 0.8 as wide as
      // they are tall. The 336x240 buffer adds the usual overscan border.
      pixelAspectX: ATARI_PIXEL_ASPECT_X,
      activeWidth: ATARI_ACTIVE_WIDTH,
      activeHeight: ATARI_ACTIVE_HEIGHT,
      borderLeft: ATARI_BORDER_LEFT,
      borderTop: ATARI_BORDER_TOP,
    },
    ui: uiFor(model as AtariModel, atariRegionForLocale(locale) === 'pal'),
  };
}

export const atariEntry: MachineEntry = {
  kind: 'atari',
  models: ATARI_MODELS,
  descriptor: atariDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null, locale?: MachineLocale) {
    return new AtariMachine(model as AtariModel, display, atariRegionForLocale(locale));
  },
  /** AltirraOS (10K on the 400/800, 16K on the XLs), then internal Altirra
   *  BASIC on the 600XL/800XL. The same images serve both regions. */
  romSources(model: MachineModel) {
    const info = atariInfo(model as AtariModel);
    return info.builtinBasic ? [info.osSource, ALTIRRA_BASIC_SOURCE] : [info.osSource];
  },
  /** BASIC is a cartridge on the 400/800/1200XL; mount Altirra BASIC when the
   *  slot is empty. */
  bootCartridgeSource(model: MachineModel) {
    return atariInfo(model as AtariModel).builtinBasic ? undefined : ALTIRRA_BASIC_SOURCE;
  },
  /**
   * A 10K image is a 400/800 OS and a 16K image an XL OS (each serving both
   * regions); an 8K image dropped on the ROM pane is a BASIC cartridge, not a
   * system ROM, so it is left to the media path rather than being installed
   * as firmware.
   */
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    const currentXl = isAtariModel(current) && atariInfo(current).xl;
    if (data.length === ATARI_OS_SIZE) {
      return isAtariModel(current) && !currentXl ? current : 'atari800';
    }
    if (data.length === ATARI_XL_OS_SIZE) return currentXl ? current : 'atari800xl';
    return null;
  },
};
