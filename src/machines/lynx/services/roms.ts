/**
 * LynxRomService — one 8K socket per system image, plus the DOS ROM.
 *
 * The 48K has two system images; the 96K/128K have three and, above them, the
 * disk interface's DOS ROM. Every socket is independently overridable (the
 * MTX-style multi-slot machinery at an 8K stride), and the DOS socket disappears
 * when the Hardware pane's FD1793 toggle is off. No cartridge slot.
 */

import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';
import type { LynxMachine } from '../lynx-machine.ts';
import { LYNX_ROM_SLOT_SIZE, lynxDosSlot, lynxRomSlotLabels } from '../models.ts';

export class LynxRomService implements RomService {
  constructor(
    private readonly m: LynxMachine,
    private readonly host: () => MachineHost | null,
  ) {}

  /** The sockets actually fitted: the DOS socket is gone when the disk
   *  interface is switched off. */
  private effectiveSlotCount(): number {
    const labels = lynxRomSlotLabels(this.m.model);
    return lynxDosSlot(this.m.model) >= 0 && !this.m.hasDisk
      ? labels.length - 1
      : labels.length;
  }

  get systemSlots(): readonly RomSlotInfo[] {
    const ops = this.host()?.roms;
    const labels = lynxRomSlotLabels(this.m.model);
    const out: RomSlotInfo[] = [];
    for (let index = 0; index < this.effectiveSlotCount(); index++) {
      const p = ops?.cachedPage(index) ?? null;
      out.push({
        index,
        title: labels[index],
        label: p?.label ?? labels[index],
        size: p?.size ?? 0,
        overridden: p !== null,
      });
    }
    return out;
  }

  installSystemRom(data: Uint8Array): void { this.m.loadROM(data); }

  async setSystemRom(data: Uint8Array, label: string, page?: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    if (page === undefined) {
      await ops.persistFull(data, label);
      await ops.rebuild();
      return;
    }
    // A full concatenated image dropped on any one socket splits across every
    // socket — the real ROM layout — so a combined dump "just works".
    const count = this.effectiveSlotCount();
    if (data.length >= count * LYNX_ROM_SLOT_SIZE) {
      for (let i = 0; i < count; i++) {
        await ops.persistPage(
          i,
          data.subarray(i * LYNX_ROM_SLOT_SIZE, (i + 1) * LYNX_ROM_SLOT_SIZE),
          `${label} (rom ${i + 1})`,
        );
      }
    } else {
      await ops.persistPage(page, data.subarray(0, LYNX_ROM_SLOT_SIZE), label);
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

  readonly cartridge: CartridgeSlot | null = null;
}
