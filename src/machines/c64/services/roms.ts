/**
 * C64RomService — one socket per ROM chip: BASIC, the KERNAL and the
 * character ROM, each independently overridable (the MTX-style multi-slot
 * machinery at an 8K stride, see `C64_ROM_SLOT_SIZE`). An override is cut to
 * its chip's size. No cartridge slot yet.
 */

import type {
  CartridgeSlot, MachineHost, RomService, RomSlotInfo, SidewaysRomSlot,
} from '@/machines/machine.ts';
import type { C64Machine } from '../c64-machine.ts';
import { C64_ROM_CHIP_SIZES, C64_ROM_SLOT_LABELS } from '../models.ts';
import { C64_ROM_SIZE } from '../constants.ts';
import { DRIVE_ROM_SIZE } from '../drive/drive-1541.ts';

export class C64RomService implements RomService {
  constructor(
    private readonly m: C64Machine,
    private readonly host: () => MachineHost | null,
  ) {}

  get systemSlots(): readonly RomSlotInfo[] {
    const ops = this.host()?.roms;
    return C64_ROM_SLOT_LABELS.map((title, index): RomSlotInfo => {
      const p = ops?.cachedPage(index) ?? null;
      return {
        index,
        title,
        label: p?.label ?? title,
        size: p?.size ?? 0,
        overridden: p !== null,
      };
    });
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
    // The three ROMs end to end, dropped on any socket, fill every socket.
    if (data.length >= C64_ROM_SIZE) {
      let at = 0;
      for (let i = 0; i < C64_ROM_CHIP_SIZES.length; i++) {
        const size = C64_ROM_CHIP_SIZES[i];
        await ops.persistPage(i, data.subarray(at, at + size), `${label} (${C64_ROM_SLOT_LABELS[i]})`);
        at += size;
      }
    } else {
      await ops.persistPage(page, data.subarray(0, C64_ROM_CHIP_SIZES[page] ?? 0), label);
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

  /** The disk drive's DOS ROM is a socket of its own, while a drive is fitted. */
  get sidewaysSlots(): readonly SidewaysRomSlot[] {
    const drive = this.m.drive;
    if (!drive) return [];
    return [{
      index: 0,
      title: '1541 DOS',
      label: drive.hasRom ? '1541 DOS ROM' : '',
      size: drive.hasRom ? DRIVE_ROM_SIZE : 0,
      overridden: false,
    }];
  }

  installSidewaysRom(index: number, data: Uint8Array): void {
    if (index === 0) this.m.installDrive(data);
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
