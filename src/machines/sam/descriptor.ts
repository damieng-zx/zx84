/**
 * SAM Coupé descriptor — pure metadata plus the machine factory.
 *
 * Imported only by `registry.ts`, and must stay headless-safe: no solid-js, no
 * reactive state, since the MCP server, Node tests and the headless harness all
 * import it.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { SamModel } from './models.ts';
import { isSamModel } from './models.ts';
import { SamMachine } from './sam-machine.ts';
import {
  SAM_BORDER_LEFT, SAM_BORDER_TOP, SAM_DISPLAY_HEIGHT, SAM_DISPLAY_WIDTH,
  SAM_ROM_SIZE, SAM_SCREEN_HEIGHT, SAM_SCREEN_WIDTH,
} from './constants.ts';

const SAM_UI: MachineUiCapabilities = {
  // No microdrives, no mouse (yet), no Sinclair sysvars, and the font pane's
  // ROM-capture heuristic is Spectrum-specific.
  hiddenPanes: ['microdrive-panel', 'mouse-panel', 'sysvar-panel', 'font-panel'],
  memoryLayout: true,
  trace: false,
  colorMap: 'sam',
  // The Accuracy drop-down selects per-t-state ULA rendering, which the SAM's
  // ASIC does not do. Its contention toggle lives in the Hardware pane instead.
  accuracy: false,
  builtinDisk: true,
  joystick: true,
  fixedJoystick: true,
  mouse: false,
  cartridge: false,
  systemRomLabel: 'SAM ROM',
  // The two 16K halves are one physical EPROM, never independently overridden.
  romPages: 0,
  beeper: true,
  statusLeds: ['kbd', 'kemp', 'ear', 'load', 'dsk', 'beep', 'psg', 'rainbow'],
  keyboardBus: 'ula',
  tape: 'deck',
  tapeSound: false,
  tapeExtensions: ['.tap', '.tzx', '.csw', '.zip'],
  // The no-snapshot arm of the Save menu: screenshot, screen and RAM only.
  // 'spectrum' would offer .szx/.z80 saves this machine cannot produce.
  saveMenu: 'vdp',
  zipPolicy: 'media',
  persistMedia: true,
  bootDisk: false,
  library: false,
  memoryRegions: [
    { value: 'sam-rom0', label: 'ROM 0 (0000-3FFF)' },
    { value: 'sam-rom1', label: 'ROM 1 (C000-FFFF)' },
  ],
  charset: 'spectrum',
};

export function samDescriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  return {
    kind: 'sam',
    model,
    locale,
    cpuFamily: 'z80',
    screen: {
      width: SAM_SCREEN_WIDTH,
      height: SAM_SCREEN_HEIGHT,
      // The buffer is sampled at mode 3's 512-pixel horizontal resolution, so
      // it presents at half width — 384x288, exactly 4:3. Same reasoning as
      // the CPC's 768-wide buffer.
      pixelAspectX: 0.5,
      activeWidth: SAM_DISPLAY_WIDTH,
      activeHeight: SAM_DISPLAY_HEIGHT,
      borderLeft: SAM_BORDER_LEFT,
      borderTop: SAM_BORDER_TOP,
    },
    ui: SAM_UI,
  };
}

export const samEntry: MachineEntry = {
  kind: 'sam',
  models: ['sam256', 'sam512', 'sam1m'],
  descriptor: samDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new SamMachine(model as SamModel, display);
  },
  /**
   * One 32K image holding both ROM halves, identical across the three models.
   * It is hosted zipped, which `rom-manager` unwraps on the way through — see
   * `unwrapRomArchive`.
   */
  romSources() {
    return ['samcoupe/SAM30-PLC.zip'];
  },
  /**
   * A dropped raw system ROM is ours only if it is exactly 32K *and* a SAM is
   * already selected. A 32K image is equally a legal CPC OS+BASIC pair, so we
   * deliberately do not claim it from another family — the user picks the SAM
   * first, then drops the ROM.
   */
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    if (data.length !== SAM_ROM_SIZE) return null;
    return isSamModel(current) ? current : null;
  },
};
