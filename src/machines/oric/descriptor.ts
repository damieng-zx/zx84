/**
 * Oric registry entry — pure metadata plus the machine factory.
 *
 * Imported only by `registry.ts`; stays headless-safe (no solid-js, no reactive
 * state).
 *
 * The capability flags are honest: this machine has no cartridge slot, no mouse
 * and no joystick, and its `builtinDisk` is a *fitted* Microdisc, so the flag is
 * gated on the Hardware pane's setting through `requires.builtinDisk`. Phase 1
 * ships the machine without disks, tape or a cartridge; the flags land with the
 * services that honour them.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { isOricModel, oricModelInfo, oricRomLabel, type OricModel } from './models.ts';
import { OricMachine } from './oric-machine.ts';
import {
  ORIC_ACTIVE_HEIGHT, ORIC_ACTIVE_WIDTH, ORIC_BORDER_LEFT, ORIC_BORDER_TOP,
  ORIC_PIXEL_ASPECT_X, ORIC_SCREEN_HEIGHT, ORIC_SCREEN_WIDTH,
} from './constants.ts';

/** Panes this machine has no hardware for. */
const HIDDEN = [
  'microdrive-panel', 'mouse-panel', 'sysvar-panel', 'font-panel', 'joystick-panel',
];

function oricUi(): MachineUiCapabilities {
  return {
    hiddenPanes: HIDDEN,
    // ROM / overlay RAM / Microdisc EPROM, and the page-3 I/O block.
    memoryLayout: true,
    trace: true,
    traceModes: ['full', 'portio'],
    // Eight fixed 1-bit RGB colours: the closest existing family is the
    // Spectrum's eight, and the ULA cannot change them.
    colorMap: 'spectrum',
    // The ULA draws a whole line at a time from its 40-byte row; there is no
    // per-cycle effect to model.
    accuracy: false,
    // A Microdisc is an add-on the Hardware pane fits, so the Drives pane shows
    // only while that setting is on — the capability is gated on it.
    builtinDisk: true,
    builtinDrives: 4,
    requires: { builtinDisk: 'oric-microdisc' },
    joystick: false,
    fixedJoystick: false,
    mouseTypes: [],
    cartridge: false,
    systemRomLabel: 'System ROM',
    romPages: 0,
    beeper: false,
    soundChip: 'AY-3-8912',
    soundDevices: [{ id: 'psg', label: 'AY-3-8912', volumeSetting: 'beeper-volume' }],
    psgControls: ['filter'],
    statusLeds: ['kbd', 'load', 'chip', 'text'],
    // VIA port B drives a row, the PSG's port A selects a column.
    keyboardBus: 'matrix',
    // The cassette hangs off VIA port B: PB6 motor, PB7 data out, CB1 data in.
    tape: 'deck',
    tapeSound: false,
    tapeExtensions: ['.tap', '.zip'],
    // No `screen-scr`: `.scr` is the Spectrum's interleaved bitmap+attribute
    // layout and means nothing on a machine with a flat 40x28 text screen. The
    // screenshot covers the picture and the raw RAM dump the screen bytes.
    // No `tape-tap` either: the exporter's decoder is not written yet (see
    // `decodeSavedTape`), so offering the entry would promise a file that is
    // never produced.
    saveMenu: ['snapshot-oricstate', 'screenshot-png', 'ram-bin'],
    zipPolicy: 'media',
    persistMedia: true,
    bootDisk: false,
    library: false,
    memoryRegions: [
      { value: 'rom', label: 'System ROM (BASIC + OS)' },
      { value: 'overlay', label: 'Overlay RAM' },
      { value: 'eprom', label: 'Microdisc EPROM' },
    ],
    charset: 'spectrum',
    memoryMappedIo: true,
  };
}

export function oricDescriptor(
  model: MachineModel,
  _locale: MachineLocale = 'uk',
): MachineDescriptor {
  const m: OricModel = isOricModel(model) ? model : 'atmos';
  return {
    kind: 'oric',
    model,
    // Region does not change the hardware; the ULA's own attribute picks 50/60 Hz.
    locale: 'uk',
    cpuFamily: 'm6502',
    screen: {
      width: ORIC_SCREEN_WIDTH,
      height: ORIC_SCREEN_HEIGHT,
      pixelAspectX: ORIC_PIXEL_ASPECT_X,
      activeWidth: ORIC_ACTIVE_WIDTH,
      activeHeight: ORIC_ACTIVE_HEIGHT,
      borderLeft: ORIC_BORDER_LEFT,
      borderTop: ORIC_BORDER_TOP,
    },
    ui: { ...oricUi(), systemRomLabel: oricRomLabel(m) },
  };
}

export const oricEntry: MachineEntry = {
  kind: 'oric',
  models: ['atmos', 'oric1'],
  descriptor: oricDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new OricMachine(isOricModel(model) ? model : 'atmos', display);
  },
  romSources(model: MachineModel) {
    const m: OricModel = isOricModel(model) ? model : 'atmos';
    return oricModelInfo(m).romSources;
  },
  /**
   * A dropped 16 KB image is one of the two BASIC ROMs. They differ in the
   * banner string the ROM prints at boot (`ORIC EXTENDED BASIC V1.0` or
   * `… V1.1`), which sits just under 12 KB into both images. Anything else is
   * not an Oric ROM.
   */
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    if (data.length !== 0x4000) return null;
    const text = latin1(data);
    if (!text.includes('ORIC EXTENDED BASIC')) return null;
    if (text.includes('V1.0')) return 'oric1';
    if (text.includes('V1.1')) return 'atmos';
    return isOricModel(current) ? current : null;
  },
};

/** The image as a Latin-1 string, for signature checks. */
function latin1(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 4096) {
    out += String.fromCharCode(...data.subarray(i, i + 4096));
  }
  return out;
}
