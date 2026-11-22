/**
 * Acorn System memory map, as a set of cards rather than one fixed picture.
 *
 *   1K or 2K static RAM on the CPU card, from &0000
 *   the VDU card's character RAM: 1K at &0400 (teletext) or 2K at &1000 (80x25)
 *   the CRTC: &0800 (teletext) or &1840 (80x25)
 *   the 8271 at &0A00 when that card is fitted (System 3/4/5)
 *   the VIB at &0C00 (never fitted here)
 *   the CPU card's keyboard chip at &0E00: an INS8154 (System 1-4) or a 6522
 *     (System 5), both answering at &0E21 for the keyboard
 *   RAM cards: 8K at &2000 (and &4000 on a System 4), or 32K at &2000
 *   the resident 4K BASIC at &C000 when the 8K RAM + 8K ROM card has it
 *   the system ROM at the top: the COS at &F800 or a 4K DOS/kernel at &F000
 *
 * Addresses nothing claims read as the floating bus. That is 0x00 here, which
 * is what the system software expects: the kernel's printer path reads the
 * absent VIB's control register and exits when it reads 0, and the disc
 * routines poll an absent 8271's status for "not busy" as bit 7 clear.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import type { RamCard } from './models.ts';

/** Where each card sits on this machine's backplane. */
export interface AcornSystemLayout {
  readonly mainRamSize: number;
  readonly vramBase: number;
  readonly vramSize: number;
  readonly crtcBase: number;
  readonly fdcBase: number;
  readonly piaBase: number;
  readonly ramCards: readonly RamCard[];
  readonly basicBase: number;
  readonly basicSize: number;
}

export const ACORN_SYSTEM_OPEN_BUS = 0x00;
/** The ROM occupies the top 4K of the map; a 2K image starts at 0xF800. */
export const ACORN_SYSTEM_ROM_BASE = 0xF000;
export const ACORN_SYSTEM_ROM_TOP = 0x10000;

export class AcornSystemMemory implements IMachineMemory {
  readonly mainRam: Uint8Array;
  /** The VDU card's character RAM, addressed by the CRTC's MA. */
  readonly videoRam: Uint8Array;
  /** The RAM cards' storage, in the layout's order. */
  readonly cardRam: Uint8Array[];
  /** The resident 4K BASIC PROM, when the memory card carries one. */
  readonly basicRom = new Uint8Array(0x1000);
  /** The system ROM as the top 4K of the address space (0xF000-0xFFFF). */
  readonly rom = new Uint8Array(0x1000);
  romLength = 0;
  basicFitted = false;

  constructor(private readonly layout: AcornSystemLayout) {
    this.mainRam = new Uint8Array(layout.mainRamSize);
    this.videoRam = new Uint8Array(layout.vramSize);
    this.cardRam = layout.ramCards.map(card => new Uint8Array(card.size));
  }

  /** CRTC register select (+0) and data (+1). */
  crtcRead: (reg: number) => number = () => ACORN_SYSTEM_OPEN_BUS;
  crtcWrite: (reg: number, value: number) => void = () => {};
  crtcPeek: (reg: number) => number = () => ACORN_SYSTEM_OPEN_BUS;
  /** The 8271 card (System 3/4/5), addressed by the low byte. */
  fdcFitted = false;
  fdcRead: (offset: number) => number = () => ACORN_SYSTEM_OPEN_BUS;
  fdcWrite: (offset: number, value: number) => void = () => {};
  fdcPeek: (offset: number) => number = () => ACORN_SYSTEM_OPEN_BUS;
  /** The CPU card's keyboard chip, addressed by the low byte. */
  piaRead: (offset: number) => number = () => ACORN_SYSTEM_OPEN_BUS;
  piaWrite: (offset: number, value: number) => void = () => {};
  piaPeek: (offset: number) => number = () => ACORN_SYSTEM_OPEN_BUS;

  /** Where the installed ROM image starts in the address space. */
  get romBase(): number { return ACORN_SYSTEM_ROM_TOP - this.romLength; }

  /** Read a byte of the installed image, or the floating bus below its start. */
  private romByte(addr: number): number {
    if (this.romLength === 0 || addr < this.romBase) return ACORN_SYSTEM_OPEN_BUS;
    return this.rom[addr - ACORN_SYSTEM_ROM_BASE];
  }

  /** Which RAM card covers `addr`, and its offset, or -1. */
  private cardAt(addr: number): number {
    const cards = this.layout.ramCards;
    for (let i = 0; i < cards.length; i++) {
      if (addr >= cards[i].base && addr < cards[i].base + cards[i].size) return i;
    }
    return -1;
  }

  get ramBankCount(): number {
    return this.layout.ramCards.reduce((n, c) => n + (c.size >> 12), 0);
  }

  getRamBank(n: number): Uint8Array {
    const count = this.ramBankCount;
    let bank = ((n % count) + count) % count;
    for (let i = 0; i < this.cardRam.length; i++) {
      const banks = this.layout.ramCards[i].size >> 12;
      if (bank < banks) return this.cardRam[i].subarray(bank * 0x1000, (bank + 1) * 0x1000);
      bank -= banks;
    }
    return this.cardRam[0].subarray(0, 0x1000);
  }

  private ioByte(addr: number, peek: boolean): number {
    const { crtcBase, fdcBase, piaBase, basicBase, basicSize, vramBase, vramSize } = this.layout;
    if (addr < this.mainRam.length) return this.mainRam[addr];
    if (addr >= vramBase && addr < vramBase + vramSize) return this.videoRam[addr - vramBase];
    if (addr >= crtcBase && addr < crtcBase + 0x100) {
      return peek ? this.crtcPeek(addr & 1) : this.crtcRead(addr & 1);
    }
    if (addr >= fdcBase && addr < fdcBase + 0x100) {
      return this.fdcFitted
        ? (peek ? this.fdcPeek(addr & 0xFF) : this.fdcRead(addr & 0xFF))
        : ACORN_SYSTEM_OPEN_BUS;
    }
    if (addr >= piaBase && addr < piaBase + 0x100) {
      return peek ? this.piaPeek(addr & 0xFF) : this.piaRead(addr & 0xFF);
    }
    const card = this.cardAt(addr);
    if (card >= 0) return this.cardRam[card][addr - this.layout.ramCards[card].base];
    if (basicSize > 0 && addr >= basicBase && addr < basicBase + basicSize) {
      return this.basicFitted ? this.basicRom[addr - basicBase] : ACORN_SYSTEM_OPEN_BUS;
    }
    if (addr >= ACORN_SYSTEM_ROM_BASE) return this.romByte(addr);
    return ACORN_SYSTEM_OPEN_BUS;
  }

  readByte(addr: number): number { return this.ioByte(addr & 0xFFFF, false); }
  peekByte(addr: number): number { return this.ioByte(addr & 0xFFFF, true); }

  writeByte(addr: number, value: number): void {
    addr &= 0xFFFF;
    const v = value & 0xFF;
    const { crtcBase, fdcBase, piaBase, vramBase, vramSize } = this.layout;
    if (addr < this.mainRam.length) { this.mainRam[addr] = v; return; }
    if (addr >= vramBase && addr < vramBase + vramSize) { this.videoRam[addr - vramBase] = v; return; }
    if (addr >= crtcBase && addr < crtcBase + 0x100) { this.crtcWrite(addr & 1, v); return; }
    if (addr >= fdcBase && addr < fdcBase + 0x100) {
      if (this.fdcFitted) this.fdcWrite(addr & 0xFF, v);
      return;
    }
    if (addr >= piaBase && addr < piaBase + 0x100) { this.piaWrite(addr & 0xFF, v); return; }
    const card = this.cardAt(addr);
    if (card >= 0) this.cardRam[card][addr - this.layout.ramCards[card].base] = v;
    // ROM writes are ignored, as on the real cards.
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.peekByte((addr + i) & 0xFFFF);
    return out;
  }

  snapshot(): Uint8Array {
    return this.readBlock(0, 0x10000);
  }

  /**
   * Install the system ROM. A 2K image lands at 0xF800 (the COS), a 4K one at
   * 0xF000 (a DOS/kernel) — the same rule the hardware's address decoding
   * gives, since the ROM occupies the top of the map.
   */
  loadRom(data: Uint8Array): void {
    const len = Math.min(data.length, this.rom.length);
    this.rom.fill(0);
    this.rom.set(data.subarray(data.length - len), this.rom.length - len);
    this.romLength = len;
  }

  /** Install the 4K integer BASIC PROM at &C000. */
  loadBasic(data: Uint8Array): void {
    this.basicRom.fill(0);
    this.basicRom.set(data.subarray(0, this.basicRom.length));
    this.basicFitted = data.length > 0;
  }

  /** A reset leaves the RAM contents alone, as the cards do. */
  reset(): void {}
}
