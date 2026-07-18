/**
 * Spectrum RomService — system-ROM slot layout + override splice rules, and
 * the ZX Interface 2 cartridge slot.
 *
 * The machine owns which sockets exist (single ROM vs 2/4 pages per model)
 * and how a dropped image maps onto them (a full-span image splits across all
 * pages). The host owns override *storage* and the rebuild that makes a new
 * ROM take effect (RomHostOps — the operator's EPROM box). With no host
 * attached (headless), setters are no-ops beyond validation.
 */

import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { romPageSlotCount, defaultRomPageLabel, isInterface2Capable, type RomPage } from '@/machines/spectrum/models.ts';
import { BANK_SIZE } from '@/utils/bank-size.ts';

class If2CartridgeSlot implements CartridgeSlot {
  constructor(private readonly s: Spectrum) {}

  get name(): string { return this.s.interface2.name; }

  /** Insert and reboot into the cartridge — matching real hardware, where
   *  booting it means power-cycling with it already plugged in. The shell
   *  restarts the machine afterwards (it knows whether a ROM is loaded). */
  insert(data: Uint8Array, name: string): void {
    this.s.stop();
    this.s.interface2.insert(data, name);
    this.s.reset();
  }

  eject(): void {
    this.s.stop();
    this.s.interface2.eject();
    this.s.reset();
  }
}

export class SpectrumRomService implements RomService {
  private readonly if2: If2CartridgeSlot;

  constructor(private readonly s: Spectrum, private readonly host: () => MachineHost | null) {
    this.if2 = new If2CartridgeSlot(s);
  }

  get systemSlots(): readonly RomSlotInfo[] {
    const ops = this.host()?.roms;
    const pageCount = romPageSlotCount(this.s.model);
    if (pageCount === 0) {
      const c = ops?.cached() ?? null;
      return [{ index: 0, label: c?.label ?? '', size: c?.size ?? 0, overridden: c?.isCustom ?? false }];
    }
    const slots: RomSlotInfo[] = [];
    for (let page = 0; page < pageCount; page++) {
      const p = ops?.cachedPage(page) ?? null;
      slots.push({
        index: page,
        label: p?.label ?? defaultRomPageLabel(this.s.model, page as RomPage),
        size: p?.size ?? 0,
        overridden: p !== null,
      });
    }
    return slots;
  }

  async setSystemRom(data: Uint8Array, label: string, page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    if (page === undefined) {
      await ops.persistFull(data, label);
      await ops.rebuild();
      return;
    }
    const pageCount = romPageSlotCount(this.s.model);
    if (pageCount === 0) {
      this.host()?.setStatus('This model has a single System ROM');
      return;
    }
    // A combined image spanning every page splits across all of them regardless
    // of which slot triggered the load — matching the real ROM's layout — so
    // loading a full image into any one slot "just works".
    if (data.length >= pageCount * BANK_SIZE) {
      for (let i = 0; i < pageCount; i++) {
        await ops.persistPage(i, data.subarray(i * BANK_SIZE, (i + 1) * BANK_SIZE), `${label} (bank ${i + 1})`);
      }
    } else {
      await ops.persistPage(page, data.subarray(0, BANK_SIZE), label);
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

  get cartridge(): CartridgeSlot | null {
    return isInterface2Capable(this.s.model) ? this.if2 : null;
  }
}
