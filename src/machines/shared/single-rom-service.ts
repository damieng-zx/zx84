import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';

/**
 * RomService for a machine with exactly one system-ROM socket.
 *
 * The host owns override storage and the rebuild that makes a new ROM take
 * effect (RomHostOps); with no host attached (headless) the setters are no-ops.
 * A subclass adds what is specific — a cartridge slot, or hiding the socket from
 * the ROM pane (`showSlot = false`) when the ROM is not user-replaceable.
 */
export class SingleRomService<M extends { loadROM(data: Uint8Array): void }> implements RomService {
  /** Whether the ROM pane lists the system socket. */
  protected readonly showSlot: boolean = true;

  constructor(
    protected readonly machine: M,
    protected readonly host: () => MachineHost | null,
  ) {}

  get systemSlots(): readonly RomSlotInfo[] {
    if (!this.showSlot) return [];
    const cached = this.host()?.roms?.cached() ?? null;
    return [{ index: 0, label: cached?.label ?? '', size: cached?.size ?? 0, overridden: cached?.isCustom ?? false }];
  }

  installSystemRom(data: Uint8Array): void { this.machine.loadROM(data); }

  async setSystemRom(data: Uint8Array, label: string, _page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.persistFull(data, label);
    await ops.rebuild();
  }

  async resetSystemRom(_page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.clearFull();
    await ops.rebuild();
  }

  get cartridge(): CartridgeSlot | null { return null; }
}
