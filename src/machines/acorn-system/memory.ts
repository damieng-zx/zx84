/**
 * Acorn System 2 memory map.
 *
 *   0x0000-0x03FF  1K static RAM on the CPU card (zero page, stack, workspace)
 *   0x0400-0x07FF  the teletext card's 1K character RAM
 *   0x0800-0x08FF  MC6845 CRTC: +0 register select, +1 data
 *   0x0900-0x09FF  second INS8154 socket on the CPU card (empty unless fitted)
 *   0x0A00-0x0AFF  the 8271 floppy controller card (System 3 only): command/status,
 *                  parameter/result, reset, and the data port at +4
 *   0x0C00-0x0CFF  Versatile Interface Board (6522 / 6850 / 8255) — not fitted
 *   0x0E00-0x0EFF  the CPU card's INS8154: keyboard on port B, cassette on port A,
 *                  its 128-byte RAM at 0x0E80-0x0EFF
 *   0x2000-0x3FFF  8K RAM on the 8K RAM + 8K ROM card
 *   0xC000-0xCFFF  the resident 4K BASIC (ROM on that card)
 *   0xD000-0xDFFF  the floating-point extension (not fitted)
 *   0xF800-0xFFFF  the 2K COS/kernel ROM
 *
 * Everything else reads as the floating bus, 0xFF. The 8154's own addressing is
 * the chip's business (see `cores/ins8154.ts`): this map just hands it the low
 * address byte.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import {
  ACORN_SYSTEM_BASIC_BASE, ACORN_SYSTEM_BASIC_SIZE, ACORN_SYSTEM_CARD_RAM_BASE,
  ACORN_SYSTEM_CARD_RAM_SIZE, ACORN_SYSTEM_CRTC_BASE, ACORN_SYSTEM_FDC_BASE,
  ACORN_SYSTEM_OPEN_BUS, ACORN_SYSTEM_PIA_BASE, ACORN_SYSTEM_RAM_SIZE,
  ACORN_SYSTEM_ROM_BASE, ACORN_SYSTEM_ROM_TOP, ACORN_SYSTEM_VRAM_BASE,
  ACORN_SYSTEM_VRAM_SIZE,
} from './constants.ts';

export class AcornSystemMemory implements IMachineMemory {
  /** The CPU card's 1K at 0x0000. */
  readonly mainRam = new Uint8Array(ACORN_SYSTEM_RAM_SIZE);
  /** The 8K card's RAM at 0x2000 (two 4K banks). */
  readonly cardRam = new Uint8Array(ACORN_SYSTEM_CARD_RAM_SIZE);
  /** The teletext card's 1K character RAM, addressed by the CRTC's MA. */
  readonly videoRam = new Uint8Array(ACORN_SYSTEM_VRAM_SIZE);
  /** The 4K BASIC PROM on the 8K RAM + 8K ROM card. */
  readonly basicRom = new Uint8Array(ACORN_SYSTEM_BASIC_SIZE);
  /** The system ROM as the top 4K of the address space (0xF000-0xFFFF). */
  readonly rom = new Uint8Array(0x1000);
  romLength = 0;
  basicFitted = false;

  /** CRTC register select (+0) and data (+1). */
  crtcRead: (reg: number) => number = () => ACORN_SYSTEM_OPEN_BUS;
  crtcWrite: (reg: number, value: number) => void = () => {};
  crtcPeek: (reg: number) => number = () => ACORN_SYSTEM_OPEN_BUS;
  /** The 8271 floppy controller card (System 3 only), addressed by the low byte. */
  fdcFitted = false;
  fdcRead: (offset: number) => number = () => ACORN_SYSTEM_OPEN_BUS;
  fdcWrite: (offset: number, value: number) => void = () => {};
  fdcPeek: (offset: number) => number = () => ACORN_SYSTEM_OPEN_BUS;
  /** The CPU card's INS8154, addressed by the low byte of 0x0E00-0x0EFF. */
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

  get ramBankCount(): number { return ACORN_SYSTEM_CARD_RAM_SIZE / 0x1000; }

  getRamBank(n: number): Uint8Array {
    const count = this.ramBankCount;
    const bank = ((n % count) + count) % count;
    return this.cardRam.subarray(bank * 0x1000, (bank + 1) * 0x1000);
  }

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr < ACORN_SYSTEM_VRAM_BASE) return this.mainRam[addr];
    if (addr < ACORN_SYSTEM_CRTC_BASE) return this.videoRam[addr - ACORN_SYSTEM_VRAM_BASE];
    if (addr < ACORN_SYSTEM_CRTC_BASE + 0x100) return this.crtcRead(addr & 1);
    if (addr >= ACORN_SYSTEM_FDC_BASE && addr < ACORN_SYSTEM_FDC_BASE + 0x100) {
      return this.fdcFitted ? this.fdcRead(addr & 0xFF) : ACORN_SYSTEM_OPEN_BUS;
    }
    if (addr >= ACORN_SYSTEM_PIA_BASE && addr < ACORN_SYSTEM_PIA_BASE + 0x100) {
      return this.piaRead(addr & 0xFF);
    }
    if (addr >= ACORN_SYSTEM_CARD_RAM_BASE && addr < ACORN_SYSTEM_CARD_RAM_BASE + ACORN_SYSTEM_CARD_RAM_SIZE) {
      return this.cardRam[addr - ACORN_SYSTEM_CARD_RAM_BASE];
    }
    if (addr >= ACORN_SYSTEM_BASIC_BASE && addr < ACORN_SYSTEM_BASIC_BASE + ACORN_SYSTEM_BASIC_SIZE) {
      return this.basicFitted ? this.basicRom[addr - ACORN_SYSTEM_BASIC_BASE] : ACORN_SYSTEM_OPEN_BUS;
    }
    if (addr >= ACORN_SYSTEM_ROM_BASE) return this.romByte(addr);
    return ACORN_SYSTEM_OPEN_BUS;
  }

  /** Side-effect-free read for the debugger and the address-space snapshot. */
  peekByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr < ACORN_SYSTEM_VRAM_BASE) return this.mainRam[addr];
    if (addr < ACORN_SYSTEM_CRTC_BASE) return this.videoRam[addr - ACORN_SYSTEM_VRAM_BASE];
    if (addr < ACORN_SYSTEM_CRTC_BASE + 0x100) return this.crtcPeek(addr & 1);
    if (addr >= ACORN_SYSTEM_FDC_BASE && addr < ACORN_SYSTEM_FDC_BASE + 0x100) {
      return this.fdcFitted ? this.fdcPeek(addr & 0xFF) : ACORN_SYSTEM_OPEN_BUS;
    }
    if (addr >= ACORN_SYSTEM_PIA_BASE && addr < ACORN_SYSTEM_PIA_BASE + 0x100) {
      return this.piaPeek(addr & 0xFF);
    }
    if (addr >= ACORN_SYSTEM_CARD_RAM_BASE && addr < ACORN_SYSTEM_CARD_RAM_BASE + ACORN_SYSTEM_CARD_RAM_SIZE) {
      return this.cardRam[addr - ACORN_SYSTEM_CARD_RAM_BASE];
    }
    if (addr >= ACORN_SYSTEM_BASIC_BASE && addr < ACORN_SYSTEM_BASIC_BASE + ACORN_SYSTEM_BASIC_SIZE) {
      return this.basicFitted ? this.basicRom[addr - ACORN_SYSTEM_BASIC_BASE] : ACORN_SYSTEM_OPEN_BUS;
    }
    if (addr >= ACORN_SYSTEM_ROM_BASE) return this.romByte(addr);
    return ACORN_SYSTEM_OPEN_BUS;
  }

  writeByte(addr: number, value: number): void {
    addr &= 0xFFFF;
    const v = value & 0xFF;
    if (addr < ACORN_SYSTEM_VRAM_BASE) { this.mainRam[addr] = v; return; }
    if (addr < ACORN_SYSTEM_CRTC_BASE) { this.videoRam[addr - ACORN_SYSTEM_VRAM_BASE] = v; return; }
    if (addr < ACORN_SYSTEM_CRTC_BASE + 0x100) { this.crtcWrite(addr & 1, v); return; }
    if (addr >= ACORN_SYSTEM_FDC_BASE && addr < ACORN_SYSTEM_FDC_BASE + 0x100) {
      if (this.fdcFitted) this.fdcWrite(addr & 0xFF, v);
      return;
    }
    if (addr >= ACORN_SYSTEM_PIA_BASE && addr < ACORN_SYSTEM_PIA_BASE + 0x100) {
      this.piaWrite(addr & 0xFF, v);
      return;
    }
    if (addr >= ACORN_SYSTEM_CARD_RAM_BASE && addr < ACORN_SYSTEM_CARD_RAM_BASE + ACORN_SYSTEM_CARD_RAM_SIZE) {
      this.cardRam[addr - ACORN_SYSTEM_CARD_RAM_BASE] = v;
    }
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
   * 0xF000 (a System 3 DOS/kernel) — the same rule the hardware's address
   * decoding gives, since the ROM occupies the top of the map.
   */
  loadRom(data: Uint8Array): void {
    const len = Math.min(data.length, this.rom.length);
    this.rom.fill(0);
    this.rom.set(data.subarray(data.length - len), this.rom.length - len);
    this.romLength = len;
  }

  /** Install the 4K integer BASIC PROM at 0xC000. */
  loadBasic(data: Uint8Array): void {
    this.basicRom.fill(0);
    this.basicRom.set(data.subarray(0, ACORN_SYSTEM_BASIC_SIZE));
    this.basicFitted = data.length > 0;
  }

  /** A reset leaves the RAM contents alone, as the cards do. */
  reset(): void {}
}
