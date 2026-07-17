/**
 * ZX Interface 2 ROM cartridge slot — 16K/48K Spectrum only.
 *
 * The Interface 2 has no software paging register: a cartridge ties /ROMCS
 * permanently active, disabling the internal ROM across the whole
 * $0000-$3FFF range and replacing it with the cartridge's own 16K ROM image
 * for as long as it stays plugged in. There is no /RD or /WR line at the
 * cartridge edge connector either, so writes to $0000-$3FFF are simply
 * ignored while a cartridge is inserted (see io-ports.ts's write8 hook) —
 * real hardware treats them as read cycles.
 *
 * This makes the emulation simpler than the VTX-5000: no I/O ports, no
 * runtime page-switching, just a whole-16K slot-0 overlay applied at
 * insert/reset time and removed on eject.
 */

import type { SpectrumMemory } from '@/memory.ts';

export class Interface2 {
  /** True once a cartridge has been inserted (until ejected). */
  inserted = false;

  /** Display name of the inserted cartridge (its filename). */
  name = '';

  /** Cartridge ROM image, zero-padded/truncated to 16KB. */
  private cartRom = new Uint8Array(16384);

  insert(data: Uint8Array, name: string): void {
    this.cartRom.fill(0);
    this.cartRom.set(data.subarray(0, 16384));
    this.name = name;
    this.inserted = true;
  }

  eject(): void {
    this.inserted = false;
    this.name = '';
  }

  /** Page the cartridge ROM into slot 0. Call after memory.loadROM()/reset(). */
  applyROM(memory: SpectrumMemory): void {
    memory.setSlot0(this.cartRom);
    memory.externalRomPaged = true;
  }
}
