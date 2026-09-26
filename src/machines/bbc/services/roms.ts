import type {
  CartridgeSlot, MachineHost, RomService, RomSlotInfo,
} from '@/machines/machine.ts';
import type { BbcMachine } from '../bbc-machine.ts';

export class BbcRomService implements RomService {
  constructor(
    private readonly machine: BbcMachine,
    private readonly host: () => MachineHost | null,
  ) {}

  /** The BBC's system ROM is a single OS+BASIC image; the pane shows it via the
   *  descriptor label rather than as independently-overridable pages. */
  get systemSlots(): readonly RomSlotInfo[] {
    return [];
  }

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

  get cartridge(): CartridgeSlot | null { return null; }
}
