import type { IScreenRenderer } from '@/display/renderer.ts';
import type { MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { Zx8xModel } from './models.ts';
import { Zx8xMachine } from './zx8x-machine.ts';
import {
  ZX8X_ACTIVE_HEIGHT, ZX8X_ACTIVE_WIDTH, ZX8X_BORDER_LEFT, ZX8X_BORDER_TOP,
  ZX8X_SCREEN_HEIGHT, ZX8X_SCREEN_WIDTH,
} from './constants.ts';

const ZX80_ROM = 'sinclair/zx80.rom';
const ZX81_ROM = 'sinclair/zx81-v2.rom';

const UI: MachineUiCapabilities = {
  hiddenPanes: ['drive-panel', 'microdrive-panel', 'tape-panel', 'sound-panel', 'joystick-panel', 'mouse-panel', 'font-panel', 'sysvar-panel', 'banks-panel'],
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
  beeper: false,
  // No sound chip at all.
  psgControls: [],
  // No sound chip, no disk, no joystick/mouse ports — only the keyboard and the
  // screen-OCR overlay have activity to show.
  statusLeds: ['kbd', 'text'],
  keyboardBus: 'ula',
  tape: 'instant',
  tapeExtensions: ['.o', '.80', '.p', '.81', '.p81', '.zip'],
  tapeSound: false,
  saveMenu: 'vdp',
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: false,
  library: true,
  memoryRegions: [{ value: 'rom0', label: 'ROM' }],
  charset: 'spectrum',
};

export function zx8xDescriptor(model: MachineModel, locale: MachineLocale = 'uk'): MachineDescriptor {
  return {
    kind: 'zx8x', model, locale, cpuFamily: 'z80',
    screen: {
      width: ZX8X_SCREEN_WIDTH, height: ZX8X_SCREEN_HEIGHT, pixelAspectX: 1,
      activeWidth: ZX8X_ACTIVE_WIDTH, activeHeight: ZX8X_ACTIVE_HEIGHT,
      borderLeft: ZX8X_BORDER_LEFT, borderTop: ZX8X_BORDER_TOP,
    },
    ui: UI,
  };
}

export const zx8xEntry: MachineEntry = {
  kind: 'zx8x',
  models: ['zx80', 'zx81'],
  descriptor: zx8xDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new Zx8xMachine(model as Zx8xModel, display);
  },
  romSources(model: MachineModel, _locale?: MachineLocale) {
    return [model === 'zx80' ? ZX80_ROM : ZX81_ROM];
  },
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    if (data.length === 0x1000) return 'zx80';
    if (data.length === 0x2000 && (current === 'zx80' || current === 'zx81')) return 'zx81';
    return null;
  },
};
