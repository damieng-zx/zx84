/**
 * Acorn System descriptor — pure metadata plus the machine factory.
 *
 * Imported only by `registry.ts`; stays headless-safe (no solid-js, no reactive
 * state) because the MCP server, Node tests and the headless harness import it.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { ACORN_TAPE_EXTENSIONS } from '@/machines/shared/acorn-tape-service.ts';
import { acornSystemModelInfo, type AcornSystemModel } from './models.ts';
import { AcornSystemMachine } from './machine.ts';
import { acornSystemVdu } from './constants.ts';
const SYSTEM_UI: MachineUiCapabilities = {
  hiddenPanes: [
    'microdrive-panel', 'mouse-panel', 'sysvar-panel', 'font-panel', 'banks-panel',
  ],
  memoryLayout: false,
  trace: true,
  traceModes: ['full', 'portio'],
  // The teletext card's eight SAA5050 colours: the BBC's palette family, and
  // the machine honours 'bbc-color-map' (PAL or measured levels). The 80x25
  // card is monochrome and ignores the choice.
  colorMapChoice: {
    setting: 'bbc-color-map',
    options: [
      { value: 'pal', label: 'PAL' },
      { value: 'measured', label: 'Measured' },
    ],
  },
  accuracy: false,
  builtinDisk: false,
  builtinDrives: 2,
  joystick: false,
  fixedJoystick: false,
  mouseTypes: [],
  cartridge: false,
  systemRomLabel: 'COS ROM',
  romPages: 0,
  beeper: false,
  psgControls: [],
  statusLeds: ['kbd', 'text'],
  keyboardBus: 'matrix',
  tape: 'deck',
  tapeSound: false,
  tapeExtensions: ACORN_TAPE_EXTENSIONS,
  // Loading only: the CUTS output side is not recorded, so no 'tape-tap'.
  saveMenu: ['screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: false,
  library: false,
  memoryRegions: [],
  charset: 'bbc',
  memoryMappedIo: true,
};

/** The disc models fit the 8271 card, so the Drive pane and its DISK LED apply. */
const DISK_UI: MachineUiCapabilities = {
  ...SYSTEM_UI,
  builtinDisk: true,
  statusLeds: ['kbd', 'text', 'dsk'],
};

/** The 80x25 card is monochrome, so the Colour map choice does not apply. */
function uiFor(info: ReturnType<typeof acornSystemModelInfo>): MachineUiCapabilities {
  const base = info.disk ? DISK_UI : SYSTEM_UI;
  // The 80x25 card is monochrome: it has no colour choice, so the pane hides it.
  return info.vdu === 'mono80' ? { ...base, colorMapChoice: undefined } : base;
}

export function acornSystemDescriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  const info = acornSystemModelInfo(model);
  const vdu = acornSystemVdu(info.vdu);
  return {
    kind: 'acorn-system',
    model,
    locale,
    cpuFamily: 'm6502',
    screen: {
      width: vdu.width,
      height: vdu.height,
      pixelAspectX: vdu.pixelAspectX,
      activeWidth: vdu.activeWidth,
      activeHeight: vdu.activeHeight,
      borderLeft: vdu.borderLeft,
      borderTop: vdu.borderTop,
    },
    ui: { ...uiFor(info), systemRomLabel: info.romLabel },
  };
}

export const acornSystemEntry = {
  kind: 'acorn-system',
  models: ['acorn-system2', 'acorn-system3', 'acorn-system4', 'acorn-system5'] as const,
  descriptor: acornSystemDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new AcornSystemMachine(model as AcornSystemModel, display);
  },
  // The COS (2K) or the DOS/kernel (4K) is the system ROM. The other cards'
  // firmware (BASIC, the 80x25 character generator) is fetched by the machine's
  // prepare() hook, since those live on their own cards.
  romSources(model: MachineModel) {
    return [acornSystemModelInfo(model).romSource];
  },
  /**
   * A raw drop is recognised by shape: 2K is the COS/kernel at &F800, 4K is a
   * System DOS/kernel at &F000. A DOS lands on a System 3, the 40-column disc
   * machine; the 80-column DOS is the same size, so it is chosen by picking the
   * System 5 rather than by dropping the ROM.
   */
  detectModelForRom(data: Uint8Array): MachineModel | null {
    if (data.length === 0x800) return 'acorn-system2';
    if (data.length === 0x1000) return 'acorn-system3';
    return null;
  },
} satisfies MachineEntry;
