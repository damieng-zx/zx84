/**
 * The system-ROM service shared by the Commodore machines whose firmware is a
 * set of separately-overridable ROM chips concatenated end to end (the C64's
 * BASIC/KERNAL/chargen, the VIC-20's, the C128's six, the Plus/4's): the
 * socket list, the override splice rules, the "a whole image dropped on any
 * socket fills every socket" rule, and the drives' DOS-ROM sockets.
 *
 * A subclass supplies the socket layout (labels, chip sizes, offsets — model
 * dependent where the machine's are), its cartridge slot, and how a burned
 * image reaches the machine (`loadRom`). The host owns override storage and
 * the rebuild (`RomHostOps`); with no host attached (headless), the setters
 * are no-ops beyond validation.
 */

import type {
  CartridgeSlot, MachineHost, RomService, RomSlotInfo, SidewaysRomSlot,
} from '@/machines/machine.ts';
import { cbmDriveRomSlots, installCbmDriveRom } from '@/machines/shared/cbm/drive-services.ts';
import type { CbmSerialBus } from '@/machines/shared/cbm/serial-bus.ts';

/** One system-ROM socket: its label, its chip's size, and where the chip
 *  starts in the concatenated default image. */
export interface CbmRomSocket {
  readonly label: string;
  readonly size: number;
  readonly offset: number;
}

/** Build the socket layout from per-chip sizes at a fixed stride. */
export function cbmRomSockets(labels: readonly string[], sizes: readonly number[], stride: number): readonly CbmRomSocket[] {
  return labels.map((label, i) => ({ label, size: sizes[i] ?? 0, offset: i * stride }));
}

/** The drives' DOS-ROM sockets, one per fitted drive (the C64's and 128's
 *  drives, the VIC-20's, the Plus/4's): `cbmDriveRomSlots` over the bus. */
export class CbmDosRomSockets {
  constructor(private readonly bus: CbmSerialBus, private readonly host: () => MachineHost | null) {}

  get slots(): readonly SidewaysRomSlot[] { return cbmDriveRomSlots(this.bus); }

  install(index: number, data: Uint8Array): void { installCbmDriveRom(this.bus, index, data); }

  async set(index: number, data: Uint8Array, label: string): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.persistSideways(index, data, label);
    await ops.rebuild();
  }

  async reset(index: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.clearSideways(index);
    await ops.rebuild();
  }
}

export abstract class CbmRomServiceBase implements RomService {
  readonly cartridge: CartridgeSlot | null = null;

  protected constructor(
    private readonly loadRom: (data: Uint8Array) => void,
    private readonly host: () => MachineHost | null,
    /** The sockets, in override order — a function because a machine's
     *  layout can depend on its model (the Plus/4's function ROMs). */
    private readonly sockets: () => readonly CbmRomSocket[],
    /** The drives' DOS-ROM sockets, where the machine has them. */
    protected readonly dosRoms: CbmDosRomSockets | null = null,
  ) {}

  get systemSlots(): readonly RomSlotInfo[] {
    const ops = this.host()?.roms;
    return this.sockets().map(({ label: title }, index): RomSlotInfo => {
      const p = ops?.cachedPage(index) ?? null;
      return { index, title, label: p?.label ?? title, size: p?.size ?? 0, overridden: p !== null };
    });
  }

  installSystemRom(data: Uint8Array): void { this.loadRom(data); }

  async setSystemRom(data: Uint8Array, label: string, page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    if (page === undefined) {
      await ops.persistFull(data, label);
      await ops.rebuild();
      return;
    }
    // The whole image, dropped on any socket, fills every socket — the real
    // ROM layout — so a combined dump "just works" regardless of which socket
    // triggered the load.
    const sockets = this.sockets();
    const last = sockets[sockets.length - 1];
    const total = last.offset + last.size;
    if (data.length >= total) {
      for (let i = 0; i < sockets.length; i++) {
        const { offset, size, label: name } = sockets[i];
        await ops.persistPage(i, data.subarray(offset, offset + size), `${label} (${name})`);
      }
    } else {
      await ops.persistPage(page, data.subarray(0, sockets[page]?.size ?? 0), label);
    }
    await ops.rebuild();
  }

  async resetSystemRom(page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    if (page === undefined) await ops.clearFull();
    else await ops.clearPage(page);
    await ops.rebuild();
  }

  /** The drives' DOS ROMs, one socket per drive model fitted. */
  get sidewaysSlots(): readonly SidewaysRomSlot[] | undefined {
    return this.dosRoms ? this.dosRoms.slots : undefined;
  }

  installSidewaysRom(index: number, data: Uint8Array): void { this.dosRoms?.install(index, data); }

  async setSidewaysRom(index: number, data: Uint8Array, label: string): Promise<void> {
    await this.dosRoms?.set(index, data, label);
  }

  async resetSidewaysRom(index: number): Promise<void> {
    await this.dosRoms?.reset(index);
  }
}
