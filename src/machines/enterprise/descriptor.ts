import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { EnterpriseModel } from './models.ts';
import { EnterpriseMachine } from './enterprise-machine.ts';
import {
  EP_ACTIVE_HEIGHT, EP_ACTIVE_LEFT, EP_ACTIVE_TOP, EP_ACTIVE_WIDTH,
  EP_FRAME_HEIGHT, EP_FRAME_WIDTH,
} from './constants.ts';

/** The panes the Enterprise has no hardware for. */
const HIDDEN = [
  'microdrive-panel', 'mouse-panel', 'joystick-panel', 'sysvar-panel', 'tape-panel',
];

const ENTERPRISE_UI: MachineUiCapabilities = {
  hiddenPanes: HIDDEN,
  memoryLayout: true,
  trace: true,
  // Nick's 256 colours are fixed by its DAC: there is no palette to choose.
  colorMap: 'mono',
  accuracy: false,
  // The EXDOS card is optional (Hardware pane); the Drives pane shows while
  // it is fitted.
  builtinDisk: true,
  requires: { builtinDisk: 'enterprise-exdos' },
  builtinDrives: 4,
  joystick: false,
  fixedJoystick: false,
  mouseTypes: [],
  cartridge: false,
  systemRomLabel: 'EXOS + BASIC ROMs',
  romPages: 0,
  beeper: false,
  psgControls: [],
  soundChip: 'DAVE',
  statusLeds: ['kbd', 'load', 'dsk', 'chip'],
  keyboardBus: 'matrix',
  tapeSound: false,
  tapeExtensions: [],
  saveMenu: ['screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: true,
  bootDisk: false,
  library: false,
  memoryRegions: [],
  charset: 'spectrum',
};

export function enterpriseDescriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  return {
    kind: 'enterprise',
    model,
    locale,
    cpuFamily: 'z80',
    screen: {
      width: EP_FRAME_WIDTH,
      height: EP_FRAME_HEIGHT,
      // 768 pixels across a 52µs line: half-width pixels on a 4:3 screen.
      pixelAspectX: 0.5,
      activeWidth: EP_ACTIVE_WIDTH,
      activeHeight: EP_ACTIVE_HEIGHT,
      borderLeft: EP_ACTIVE_LEFT,
      borderTop: EP_ACTIVE_TOP,
    },
    ui: ENTERPRISE_UI,
  };
}

export const enterpriseEntry: MachineEntry = {
  kind: 'enterprise',
  models: ['ep64', 'ep128'],
  descriptor: enterpriseDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new EnterpriseMachine(model as EnterpriseModel, display);
  },
  /** EXOS (the internal ROM) then the BASIC cartridge, end to end: the 64
   *  shipped with EXOS 2.0, the 128 with 2.1; both with IS-BASIC 2.1. */
  romSources(model: MachineModel) {
    return model === 'ep64'
      ? ['enterprise/exos20.rom', 'enterprise/basic21.rom']
      : ['enterprise/exos21.rom', 'enterprise/basic21.rom'];
  },
  /** 32K or 64K is an EXOS on its own; 48K or 80K is EXOS plus BASIC. Those
   *  sizes are other machines' ROMs too, so they only stay on an Enterprise
   *  that is already running. */
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    if (current !== 'ep64' && current !== 'ep128') return null;
    return [0x8000, 0xC000, 0x10000, 0x14000].includes(data.length) ? current : null;
  },
};
