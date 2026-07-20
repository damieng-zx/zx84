/**
 * CPC RomService — the single system-ROM socket (concatenated OS + BASIC
 * [+ AMSDOS]) plus the Plus cartridge slot.
 *
 * Non-Plus 464/664/6128 carry their firmware on-board and have no cartridge
 * port; `cartridge` is null for them. The Plus range (6128Plus / GX4000) has
 * no on-board ROMs and boots from a .CPR cartridge — the slot parses the
 * RIFF/AMS! container and hands the pages to CpcMemory.loadCartridge().
 *
 * The host owns override storage and the rebuild that makes a new ROM take
 * effect (RomHostOps); with no host attached (headless) the setters are no-ops.
 */

import type { CartridgeSlot, MachineHost, RomService, RomSlotInfo } from '@/machines/machine.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { parseCpr, isCpr } from '@/media/cartridge/cpr.ts';

/** Plus-only cartridge slot — accepts a .CPR image (RIFF/AMS!) and hands the
 *  parsed pages to memory. Inserting or ejecting power-cycles the machine so
 *  the new cartridge's firmware re-runs its boot ROM scan. */
class CpcCartridgeSlot implements CartridgeSlot {
  private cartName = '';
  constructor(private readonly m: CpcMachine) {}

  get name(): string { return this.cartName; }

  insert(data: Uint8Array, name: string): void {
    // Accept either a true .CPR container or a raw 16 KB cartridge page (the
    // latter lets a user mount a bare ROM image directly as a one-page cart).
    // Files smaller than 12 bytes can't possibly be a valid ROM image.
    let pages: (Uint8Array | undefined)[];
    if (isCpr(data)) {
      pages = parseCpr(data);
    } else if (data.length >= 0x100) {
      // Treat as a single-page cartridge. Anything shorter than 256 bytes is
      // almost certainly not a real ROM image — refuse rather than boot into
      // an empty page.
      pages = new Array(32).fill(undefined);
      pages[0] = data;
    } else {
      throw new Error('Not a CPR image (missing RIFF/AMS! signature)');
    }
    // Sanity-check bank 0: a bootable Plus cartridge puts the firmware at
    // bank 0 (CPU &0000–&3FFF), whose reset vector starts with `F3 AF 31`
    // (DI; XOR A; LD SP,&nnnn). Some "cracked" or "game-only" cartridges
    // put an upper ROM (header `01 89 7F`) or a custom loader at bank 0
    // instead — they boot on real hardware via custom loaders but typically
    // hang in emulators that don't model every ASIC quirk. Surface that as
    // a status hint rather than silently freezing on a pale-green screen.
    const page0 = pages[0];
    if (page0 && page0.length >= 3) {
      const looksLikeFirmware = page0[0] === 0xF3 && page0[1] === 0xAF && page0[2] === 0x31;
      const looksLikeUpperRom = page0[0] === 0x01 && page0[1] === 0x89 && page0[2] === 0x7F;
      if (!looksLikeFirmware) {
        const kind = looksLikeUpperRom ? 'an upper ROM (BASIC/AMSDOS)' : 'an unknown image';
        this.m.host?.setStatus(`Warning: bank 0 of ${name} looks like ${kind}, not firmware — may not boot`);
      }
    }
    this.m.stop();
    this.m.memory.loadCartridge(pages);
    this.cartName = name;
    this.m.reset();
    this.m.start();
  }

  eject(): void {
    this.m.stop();
    this.m.memory.ejectCartridge();
    this.cartName = '';
    this.m.reset();
    this.m.start();
  }
}

export class CpcRomService implements RomService {
  /** Plus cartridge slot, or null on non-Plus 464/664/6128 (no cartridge port). */
  readonly cartridge: CartridgeSlot | null;

  constructor(private readonly c: CpcMachine, private readonly host: () => MachineHost | null) {
    this.cartridge = c.config.isPlus ? new CpcCartridgeSlot(c) : null;
  }

  get systemSlots(): readonly RomSlotInfo[] {
    const c = this.host()?.roms?.cached() ?? null;
    return [{ index: 0, label: c?.label ?? '', size: c?.size ?? 0, overridden: c?.isCustom ?? false }];
  }

  installSystemRom(data: Uint8Array): void { this.c.loadROM(data); }

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
}
