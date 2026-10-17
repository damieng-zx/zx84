import type {
  CartridgeSlot, MachineHost, RomService, RomSlotInfo, SidewaysRomSlot,
} from '@/machines/machine.ts';
import type { ElectronMachine } from '../electron-machine.ts';
import { ELECTRON_ROM_SIZE } from '../models.ts';

/** What the Electron's paged ROM windows are for, by page. Pages 8-11 (the
 *  keyboard and BASIC) are not sockets. */
const PAGE_TITLES: Record<number, string> = {
  0: 'Page 0: socket SK2',
  1: 'Page 1: socket SK2',
  2: 'Page 2: socket SK1',
  3: 'Page 3: socket SK1',
  4: 'Page 4: disc interface',
  5: 'Page 5: user ROM',
  6: 'Page 6: user ROM',
  7: 'Page 7: modem interface',
  12: 'Page 12: OS (Plus 1)',
  13: 'Page 13: high-priority',
  14: 'Page 14: Econet',
  15: 'Page 15: reserved',
};
const PAGES = [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15];

class ElectronCartridgeSlot implements CartridgeSlot {
  constructor(private readonly m: ElectronMachine) {}

  get name(): string { return this.m.cartridgeName; }

  /** Inserting or removing a cartridge power-cycles the machine so the OS finds
   *  it; SHIFT+BREAK then runs it, as the Plus 1 ROM does on real hardware. */
  insert(data: Uint8Array, name: string): void {
    this.m.stop();
    this.m.insertCartridge(data, name);
    this.m.reset();
    this.m.bootWithShift();
  }

  eject(): void {
    this.m.stop();
    this.m.ejectCartridge();
    this.m.reset();
  }
}

export class ElectronRomService implements RomService {
  private readonly slot: ElectronCartridgeSlot;

  constructor(
    private readonly machine: ElectronMachine,
    private readonly host: () => MachineHost | null,
  ) {
    this.slot = new ElectronCartridgeSlot(machine);
  }

  /** The system ROM is one 32K image (BASIC + OS); the pane shows it through
   *  the descriptor label rather than as separately overridable pages. */
  get systemSlots(): readonly RomSlotInfo[] { return []; }

  installSystemRom(data: Uint8Array): void { this.machine.loadROM(data); }

  async setSystemRom(data: Uint8Array, label: string): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.persistFull(data, label);
    await ops.rebuild();
  }

  async resetSystemRom(): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.clearFull();
    await ops.rebuild();
  }

  /** The Plus 1's front cartridge slot; there is none until a Plus 1 is fitted. */
  get cartridge(): CartridgeSlot | null {
    return this.machine.plus1Fitted ? this.slot : null;
  }

  get sidewaysSlots(): readonly SidewaysRomSlot[] {
    return PAGES.map((index): SidewaysRomSlot => {
      const rom = this.machine.memory.roms[index];
      return {
        index,
        title: PAGE_TITLES[index],
        label: rom ? 'ROM fitted' : '',
        size: rom ? ELECTRON_ROM_SIZE : 0,
        overridden: false,
      };
    });
  }

  installSidewaysRom(index: number, data: Uint8Array): void {
    this.machine.loadPagedRom(index, data);
  }

  async setSidewaysRom(index: number, data: Uint8Array, label: string): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.persistSideways(index, data, label);
    await ops.rebuild();
  }

  async resetSidewaysRom(index: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.clearSideways(index);
    await ops.rebuild();
  }
}
