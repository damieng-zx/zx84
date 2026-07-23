/**
 * CPC registry entry — pure metadata + factory (re-architecture §3.5).
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type { MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities, StatusLedId } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { CpcModel } from './models.ts';
import { cpcHasDisk, cpcHasTape, cpcIsPlusClass } from './models.ts';
import { CpcMachine } from './cpc-machine.ts';
import { CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT, CPC_BORDER_LEFT, CPC_BORDER_TOP } from './constants.ts';

function cpcStatusLeds(model: MachineModel): StatusLedId[] {
  const leds: StatusLedId[] = ['kbd', 'mouse', 'text', 'ay'];
  if (cpcHasTape(model)) leds.push('load');
  if (cpcHasDisk(model)) leds.push('dsk');
  return leds;
}

function cpcUi(model: MachineModel): MachineUiCapabilities {
  return {
    hiddenPanes: ['sysvar-panel', 'font-panel'],
    memoryLayout: true,
    trace: false,
    colorMap: 'cpc',
    accuracy: false,
    builtinDisk: cpcHasDisk(model),
    joystick: true,
    fixedJoystick: true,
    mouse: true,
    cartridge: cpcIsPlusClass(model),
    systemRomSlot: !cpcIsPlusClass(model),
    systemRomLabel: 'ROM',
    romPages: 0,
    beeper: false,
    statusLeds: cpcStatusLeds(model),
    keyboardBus: 'ppi',
    // The GX4000 console has no cassette — drop the tape pane. Other CPC
    // models drive the deck through PPI Port B.
    tape: cpcHasTape(model) ? 'deck' : undefined,
    tapeSound: false,
    tapeExtensions: cpcHasTape(model) ? ['.cdt', '.tzx', '.tap', '.zip'] : [],
    saveMenu: 'cpc',
    zipPolicy: 'none',
    persistMedia: false,
    bootDisk: false,
    // The Plus range has no on-board ROM: when its cartridge slot is empty the
    // shell hidden-mounts the plus-system.cpr firmware cartridge (unshown, like
    // the Einstein Xtal-DOS phantom disk). A user cartridge supersedes it.
    bootCartridge: cpcIsPlusClass(model),
    library: false,
    memoryRegions: cpcIsPlusClass(model)
      ? [
        { value: 'cpcCartLower', label: 'Cartridge page 0 (OS)' },
        { value: 'cpcCartBasic', label: 'Cartridge page 1 (BASIC)' },
        { value: 'cpcCartAmsdos', label: 'Cartridge page 3 (AMSDOS)' },
      ]
      : [
        { value: 'cpcRomLower', label: 'ROM Lower (OS)' },
        { value: 'cpcRomBasic', label: 'ROM BASIC' },
        { value: 'cpcRomAmsdos', label: 'ROM AMSDOS' },
      ],
    charset: 'cpc',
  };
}

// Non-Plus models: OS(16KB) + BASIC(16KB) [+ AMSDOS(16KB)] fetched, concatenated
// (rom-manager) and split by CpcMemory.loadROM().
//
// The Plus range (6128Plus / GX4000) has no on-board ROMs — it boots from a
// cartridge. `plus-system.cpr` is the real Amstrad Plus firmware cartridge: v4
// OS + BASIC 1.1 + AMSDOS across pages 0–3, with the bundled Burnin' Rubber
// game on pages 4–7 (so a bare Plus boots to the authentic "f1 Amstrad BASIC /
// f2 Burnin' Rubber" menu). It is a single .CPR file, which CpcMachine.loadROM
// recognises and routes through memory.loadCartridge() rather than the
// three-ROM split. A user-loaded game .CPR later replaces it via the cartridge
// slot.
//
// NOTE: do NOT wire `cpc-plus.rom` here — that image is page 0 of this cartridge
// (the Plus OS *lower* ROM, header 01 89 7F …), NOT an AMSDOS background ROM.
// Loading it at the upper-ROM slot hangs the firmware's boot-time ROM scan,
// leaving the machine stuck before the BASIC "Ready" prompt.
const PLUS_SYSTEM_CPR = 'cpc/plus-system.cpr';

function romKey(model: CpcModel, locale?: MachineLocale): string {
  return locale && locale !== 'uk' ? `${model}-${locale}` : model;
}

const ROM_SOURCES: Record<string, string[]> = {
  // ── UK defaults ──────────────────────────────────────────────────────────
  cpc6128:     ['cpc/os-6128.rom', 'cpc/basic-1-1-6128.rom', 'cpc/amsdos.rom'],
  cpc664:      ['cpc/os-664.rom', 'cpc/basic-1-1-664.rom', 'cpc/amsdos.rom'],
  cpc464:      ['cpc/os-464.rom', 'cpc/basic-1-0.rom'],
  cpc6128plus: [],
  gx4000:      [],

  // ── Spanish ──────────────────────────────────────────────────────────────
  'cpc464-es': ['cpc/os-464-es.rom', 'cpc/basic-1-0-es.rom'],

  // ── French ───────────────────────────────────────────────────────────────
  'cpc464-fr':  ['cpc/os-464-fr.rom', 'cpc/basic-1-0-fr.rom'],
  'cpc6128-fr': ['cpc/os-6128-fr.rom', 'cpc/basic-1-1-6128-fr.rom', 'cpc/amsdos-fr.rom'],
};

/** ROM-host-relative path of the default Plus firmware cartridge (v4 OS + BASIC +
 *  AMSDOS on pages 0–3, Burnin' Rubber on 4–7). Hidden-mounted when the Plus
 *  cartridge slot is empty. */
export const PLUS_SYSTEM_CARTRIDGE = PLUS_SYSTEM_CPR;

/** Descriptor for one CPC model — shared by the registry entry and the machine
 *  instance's own `descriptor` getter. */
export function cpcDescriptor(model: MachineModel, locale: MachineLocale = 'uk'): MachineDescriptor {
  return {
    kind: 'cpc',
    model,
    locale,
    cpuFamily: 'z80',
    // The CPC frame buffer is 2× oversampled horizontally (16 Gate-Array
    // pixel clocks per character); display at half width to restore ~4:3.
    screen: {
      width: CPC_SCREEN_WIDTH, height: CPC_SCREEN_HEIGHT, pixelAspectX: 0.5,
      activeWidth: 640, activeHeight: 200,
      borderLeft: CPC_BORDER_LEFT, borderTop: CPC_BORDER_TOP,
    },
    ui: cpcUi(model),
  };
}

export const cpcEntry: MachineEntry = {
  kind: 'cpc',
  models: ['cpc464', 'cpc664', 'cpc6128', 'cpc6128plus', 'gx4000'],
  descriptor: cpcDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new CpcMachine(model as CpcModel, display);
  },
  romSources(model: MachineModel, locale?: MachineLocale) {
    const cm = model as CpcModel;
    const key = romKey(cm, locale);
    return ROM_SOURCES[key] ?? ROM_SOURCES[cm];
  },
  bootCartridgeSource(model: MachineModel) {
    return cpcIsPlusClass(model) ? PLUS_SYSTEM_CARTRIDGE : undefined;
  },
};
