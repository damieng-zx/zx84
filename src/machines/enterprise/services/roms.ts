/**
 * EnterpriseRomService — one combined system image: EXOS, then the BASIC
 * cartridge. The EXDOS ROM is the disk card's, fetched through prepare().
 */

import type {
  CartridgeSlot, MachineHost, RomService, RomSlotInfo, SidewaysRomSlot,
} from '@/machines/machine.ts';
import { EXTENSION_SOCKETS } from '../constants.ts';
import type { EnterpriseMachine } from '../enterprise-machine.ts';

export class EnterpriseRomService implements RomService {
  constructor(
    private readonly m: EnterpriseMachine,
    private readonly host: () => MachineHost | null,
  ) {}

  get systemSlots(): readonly RomSlotInfo[] {
    const c = this.host()?.roms?.cached() ?? null;
    return [{ index: 0, label: c?.label ?? '', size: c?.size ?? 0, overridden: c?.isCustom ?? false }];
  }

  installSystemRom(data: Uint8Array): void { this.m.loadROM(data); }

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

  readonly cartridge: CartridgeSlot | null = null;

  /**
   * Four extension-ROM sockets, empty by default. Much Hungarian software
   * needs one: EPDOS's HFONT and the ZozoTools commands are EXT extensions,
   * and a program that calls one without the ROM stops with "Unrecognised
   * command string".
   */
  get sidewaysSlots(): readonly SidewaysRomSlot[] {
    const out: SidewaysRomSlot[] = [];
    for (let index = 0; index < EXTENSION_SOCKETS; index++) {
      const rom = this.m.extensionRoms[index];
      out.push({
        index,
        title: `Extension ROM ${index + 1}`,
        label: rom ? 'ROM fitted' : '',
        size: rom ? rom.length : 0,
        overridden: false,
      });
    }
    return out;
  }

  installSidewaysRom(index: number, data: Uint8Array): void { this.m.loadExtensionRom(index, data); }

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
