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
  hiddenPanes: ['drive-panel', 'microdrive-panel', 'joystick-panel', 'mouse-panel', 'font-panel', 'sysvar-panel', 'banks-panel'],
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
  // No speaker of its own: sound comes from the optional ZON X-81 (an AY into
  // one speaker, so no stereo layout) and the optional VSYNC sound (the MIC
  // line, i.e. the vertical sync, mixed in like a beeper).
  beeper: false,
  psgControls: [],
  soundDevices: [
    { id: 'beeper', label: 'VSYNC sound', volumeSetting: 'beeper-volume', enabledSetting: 'zx8x-vsync-sound' },
    { id: 'psg', label: 'ZON X-81', volumeSetting: 'psg-volume', enabledSetting: 'zx8x-zonx' },
  ],
  // No disk, no joystick/mouse ports. EAR/LOAD follow the cassette deck,
  // CHIP the ZON X-81, TEXT the screen-OCR overlay.
  statusLeds: ['kbd', 'ear', 'load', 'chip', 'text'],
  keyboardBus: 'ula',
  // A pulse-level deck feeding the EAR bit, with the ROM's LOAD/SAVE trapped
  // for instant loading unless "Fast ROM loading" is turned off.
  tape: 'deck',
  fastRomLoading: true,
  tapeExtensions: ['.o', '.80', '.p', '.81', '.p81', '.tzx', '.wav', '.zip'],
  tapeSound: false,
  // 'tape-tap' downloads the most recent SAVE as the program image LOAD
  // reads back (.p on the ZX81, .o on the ZX80).
  saveMenu: ['snapshot-zx8xstate', 'tape-tap', 'screenshot-png', 'screen-scr', 'ram-bin'],
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
