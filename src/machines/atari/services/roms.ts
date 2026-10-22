/**
 * Atari ROM service: the OS and BASIC sockets, and the cartridge slot.
 *
 * The OS and BASIC are two sockets in the ROM pane, defaulting to AltirraOS
 * and Altirra BASIC, each replaceable on its own (the shell keeps a user image
 * per socket and per model, and installs it over the default at every build).
 * That matters on the 600XL/800XL/XE, whose default system image is the OS
 * with BASIC appended: a custom OS must not take BASIC away with it.
 *
 * The 400/800 OS image is 10K (2K floating-point package at $D800 followed by
 * the 8K OS at $E000) and the XL/XE one 16K; each is identical for NTSC and
 * PAL, since GTIA's PAL pin tells the OS which standard it is running on.
 * BASIC is 8K: inside the machine on the 600XL/800XL/XE, but a cartridge on the
 * 400/800/1200XL, where the descriptor's `bootCartridge` mounts it under an
 * empty name when the slot is empty (and a user BASIC takes that place).
 */

import type {
  CartridgeSlot, MachineHost, RomService, RomSlotInfo, SidewaysRomSlot,
} from '@/machines/machine.ts';
import type { AtariMachine } from '../atari-machine.ts';
import {
  ALTIRRA_BASIC_LABEL, ALTIRRA_OS_800_LABEL, ALTIRRA_OS_XL_LABEL, ATARI_BASIC_ROM_SIZE,
  ATARI_OS_SIZE, ATARI_XL_OS_SIZE, atariModelName,
} from '../models.ts';

/** The sockets, in the order the pane lists them. */
const SOCKET_OS = 0;
const SOCKET_BASIC = 1;

class AtariCartridgeSlot implements CartridgeSlot {
  constructor(private readonly m: AtariMachine) {}

  get name(): string { return this.m.cartridgeName; }

  insert(data: Uint8Array, name: string): void {
    // The shell's hidden BASIC (no name) is the default firmware: a user BASIC
    // from the ROM pane takes its place.
    if (name === '' && this.m.basicOverride) data = this.m.basicOverride;
    // The shell offers the hidden BASIC whenever the slot reads empty; with it
    // already fitted (a restored snapshot carries it), remounting would reboot.
    if (name === '' && this.m.cartridgeName === '' && this.m.memory.cart !== null) return;
    this.m.swapCartridge(() => {
      if (this.m.memory.insertCart(data)) {
        this.m.cartridgeName = name;
        // The shell's hidden BASIC (no name): keep it for auto-start.
        if (name === '') this.m.hiddenBasic = data;
        this.m.onStatus?.(`Cartridge: ${name || 'BASIC'}`);
      } else {
        this.m.onStatus?.(this.m.memory.cartError || `Unsupported cartridge: ${data.length} bytes`);
      }
    });
  }

  eject(): void {
    this.m.swapCartridge(() => {
      this.m.memory.ejectCart();
      this.m.cartridgeName = '';
      this.m.onStatus?.('Cartridge ejected');
    });
  }
}

export class AtariRomService implements RomService {
  private readonly slot: AtariCartridgeSlot;

  constructor(private readonly m: AtariMachine, private readonly host: () => MachineHost | null) {
    this.slot = new AtariCartridgeSlot(m);
  }

  /** None: the OS is one of the two sockets below, so the pane lists the
   *  OS and BASIC together (`descriptor.ui.systemRomSlot` is false). */
  readonly systemSlots: readonly RomSlotInfo[] = [];

  /** The OS and BASIC sockets with the default firmware's names; the shell
   *  swaps in the label and size of any user image stored for a socket. */
  get sidewaysSlots(): readonly SidewaysRomSlot[] {
    const mem = this.m.memory;
    return [
      {
        index: SOCKET_OS,
        title: 'OS ROM',
        label: mem.xl ? ALTIRRA_OS_XL_LABEL : ALTIRRA_OS_800_LABEL,
        size: mem.osRom.length,
        overridden: false,
      },
      {
        index: SOCKET_BASIC,
        title: 'BASIC ROM',
        label: ALTIRRA_BASIC_LABEL,
        size: ATARI_BASIC_ROM_SIZE,
        overridden: false,
      },
    ];
  }

  /** The size a socket's image must be, or 0 for no such socket. */
  private socketSize(index: number): number {
    if (index === SOCKET_OS) return this.m.memory.osRom.length;
    return index === SOCKET_BASIC ? ATARI_BASIC_ROM_SIZE : 0;
  }

  /** Why `data` cannot go in a socket, or '' when it can. */
  private socketProblem(index: number, data: Uint8Array): string {
    const size = this.socketSize(index);
    if (data.length === size) return '';
    const what = index === SOCKET_OS
      ? `the ${size >> 10}K OS of the Atari ${atariModelName(this.m.model)}`
      : 'the 8K BASIC';
    return `That ROM is ${data.length} bytes; ${what} needs ${size}`;
  }

  /** Put a stored user image over the default in a socket (build time). */
  installSidewaysRom(index: number, data: Uint8Array): void {
    const problem = this.socketProblem(index, data);
    if (problem) { this.m.onStatus?.(problem); return; }
    if (index === SOCKET_OS) {
      this.m.memory.osRom.set(data);
    } else if (this.m.memory.basicRom) {
      this.m.memory.basicRom.set(data);
    } else {
      this.m.basicOverride = data.slice();
    }
  }

  async setSidewaysRom(index: number, data: Uint8Array, label: string): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    const problem = this.socketProblem(index, data);
    if (problem) { this.m.onStatus?.(problem); return; }
    await ops.persistSideways(index, data, label);
    await ops.rebuild();
  }

  async resetSidewaysRom(index: number): Promise<void> {
    const ops = this.host()?.roms;
    if (!ops) return;
    await ops.clearSideways(index);
    await ops.rebuild();
  }

  installSystemRom(data: Uint8Array): void {
    if (!this.m.memory.loadRom(data)) {
      const [size, kb] = this.m.memory.xl ? [ATARI_XL_OS_SIZE, 16] : [ATARI_OS_SIZE, 10];
      this.m.onStatus?.(
        `Atari ${atariModelName(this.m.model)} needs the ${kb}K OS image (${size} bytes); got ${data.length}`,
      );
    }
  }

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

  get cartridge(): CartridgeSlot { return this.slot; }
}
