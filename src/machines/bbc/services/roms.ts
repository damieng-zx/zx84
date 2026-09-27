import type {
  CartridgeSlot, MachineHost, RomService, RomSlotInfo, SidewaysRomSlot,
} from '@/machines/machine.ts';
import type { BbcMachine } from '../bbc-machine.ts';
import { BBC_ROM_SIZE } from '../models.ts';

/** The Model B's sixteenth sideways socket holds the language ROM (BASIC); the
 *  disc-interface ROM (when one is fitted) conventionally sits in 13. */
const BASIC_SOCKET = 15;
const DISC_SOCKET = 13;
const SOCKETS = 16;

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

  // ── Sideways ROM sockets ─────────────────────────────────────────────────

  /** All sixteen sideways banks. The disc-interface ROM and BASIC are the
   *  machine-loaded defaults; the rest start empty until a user image is
   *  stored (the shell marks those overridden). The two default ROMs are
   *  listed first so they aren't buried among the empty sockets. */
  get sidewaysSlots(): readonly SidewaysRomSlot[] {
    const disc = this.discLabel();
    // Disc-interface ROM (when fitted) then the language ROM, then the rest
    // in socket order.
    const order: number[] = [];
    if (disc) order.push(DISC_SOCKET);
    order.push(BASIC_SOCKET);
    for (let index = 0; index < SOCKETS; index++) {
      if (!order.includes(index)) order.push(index);
    }
    return order.map((index): SidewaysRomSlot => {
      if (index === DISC_SOCKET && disc) {
        return { index, title: 'Disc interface ROM', label: disc, size: BBC_ROM_SIZE, overridden: false };
      }
      if (index === BASIC_SOCKET) {
        return { index, title: 'Language ROM (BASIC)', label: 'BASIC', size: BBC_ROM_SIZE, overridden: false };
      }
      return { index, title: `ROM socket ${index}`, label: '', size: 0, overridden: false };
    });
  }

  installSidewaysRom(index: number, data: Uint8Array): void {
    this.machine.loadSidewaysRom(index, data);
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

  private discLabel(): string {
    switch (this.machine.diskSystem) {
      case 'acorn': return 'Acorn DFS (8271)';
      case '1770': return 'Acorn 1770 DFS';
      default: return '';
    }
  }
}
