/**
 * Apple IIe memory map: the ][+'s, plus the MMU and the auxiliary 64K.
 *
 *   $0000-$01FF  zero page and stack: main RAM, or auxiliary with ALTZP
 *   $0200-$BFFF  main RAM, or auxiliary per RAMRD (reads) / RAMWRT (writes) —
 *                except that with 80STORE the text page ($0400-$07FF) and, in
 *                hi-res, the hi-res page ($2000-$3FFF) follow PAGE2 instead
 *   $C000-$C0FF  soft switches and slot I/O, decoded by the machine
 *   $C100-$CFFF  the internal ROM (with INTCXROM, and always for the built-in
 *                80-column firmware at $C300 unless SLOTC3ROM selects slot 3),
 *                otherwise the peripheral card ROMs
 *   $D000-$FFFF  system ROM, or language-card RAM (main, or auxiliary with ALTZP)
 *
 * The auxiliary RAM lives on the extended 80-column card, so without that card
 * the auxiliary side is simply not there: reads float high and writes vanish.
 */

import { Apple2Memory } from './apple2-memory.ts';

const AUX_SIZE = 0xC000;

export class Apple2eMemory extends Apple2Memory {
  /** Auxiliary 48K RAM (the extended 80-column card). */
  override readonly aux: Uint8Array = new Uint8Array(AUX_SIZE);
  /** Auxiliary language-card RAM, laid out like the main one. */
  private readonly auxLcRam = new Uint8Array(0x4000);
  /** Internal ROM image for $C000-$CFFF (only $C100-$CFFF is ever read). */
  private readonly intRom = new Uint8Array(0x1000);
  /** Whether the auxiliary RAM is fitted. */
  auxFitted = false;

  // The MMU soft switches ($C000-$C00B writes, read back at $C011-$C018).
  store80 = false;
  ramrd = false;
  ramwrt = false;
  intcxrom = false;
  altzp = false;
  slotc3rom = false;
  /** Latched when the internal $C3xx firmware is touched: $C800-$CFFF is then
   *  internal ROM too, until $CFFF is accessed. */
  intc8rom = false;

  // Display switches the 80STORE paging needs.
  page2 = false;
  hires = false;

  private mainRead(addr: number, aux: boolean): number {
    if (aux) return this.auxFitted ? this.aux[addr] : 0xFF;
    return this.ram[addr];
  }

  /** Whether an access to `addr` ($0200-$BFFF) goes to auxiliary RAM. */
  private usesAux(addr: number, byReadSwitch: boolean): boolean {
    if (this.store80 && ((addr >= 0x0400 && addr < 0x0800) || (this.hires && addr >= 0x2000 && addr < 0x4000))) {
      return this.page2;
    }
    return byReadSwitch ? this.ramrd : this.ramwrt;
  }

  private internalRom(addr: number): number { return this.intRom[addr - 0xC000]; }

  /** $C100-$CFFF: which ROM answers, with the INTC8ROM latch's side effects. */
  private cxRead(addr: number, latch: boolean): number {
    if (addr === 0xCFFF && latch) {
      this.intc8rom = false;
      if (this.intcxrom) return this.internalRom(addr);
      return this.cxPeripheralRead(addr, true);       // releases a card's expansion area too
    }
    if (this.intcxrom) return this.internalRom(addr);
    if (addr < 0xC800) {
      const slot = (addr >> 8) & 7;
      if (slot === 3 && !this.slotc3rom) {
        if (latch) this.intc8rom = true;
        return this.internalRom(addr);
      }
      return this.cxPeripheralRead(addr, latch);
    }
    if (this.intc8rom) return this.internalRom(addr);
    return this.cxPeripheralRead(addr, latch);
  }

  /** The language-card RAM the ALTZP switch currently selects, if any. */
  private lcBank(): Uint8Array | null {
    if (!this.altzp) return this.lcRam;
    return this.auxFitted ? this.auxLcRam : null;
  }

  override readByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr < 0x0200) return this.mainRead(addr, this.altzp);
    if (addr < 0xC000) return this.mainRead(addr, this.usesAux(addr, true));
    if (addr < 0xC100) {
      const v = this.ioRead(addr);
      return v >= 0 ? v & 0xFF : 0xFF;
    }
    if (addr < 0xD000) return this.cxRead(addr, true);
    if (this.lcRead) {
      const bank = this.lcBank();
      return bank ? bank[this.lcIndex(addr)] : 0xFF;
    }
    return this.rom[addr - 0xD000];
  }

  override writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    val &= 0xFF;
    if (addr < 0x0200) {
      if (this.altzp) { if (this.auxFitted) this.aux[addr] = val; } else this.ram[addr] = val;
      return;
    }
    if (addr < 0xC000) {
      if (this.usesAux(addr, false)) { if (this.auxFitted) this.aux[addr] = val; } else this.ram[addr] = val;
      return;
    }
    if (addr < 0xC100) { this.ioWrite(addr, val); return; }
    if (addr < 0xD000) {                                       // writes still trip the ROM-select latches
      if (addr === 0xCFFF) this.intc8rom = false;
      else if (addr >= 0xC300 && addr < 0xC400 && !this.intcxrom && !this.slotc3rom) this.intc8rom = true;
      if (!this.intcxrom) this.cxPeripheralWrite(addr, val);
      return;
    }
    if (this.lcWrite) {
      const bank = this.lcBank();
      if (bank) bank[this.lcIndex(addr)] = val;
    }
  }

  /** What a read would return, with no side effects (the $C0xx window as 0). */
  private peek(addr: number): number {
    if (addr < 0x0200) return this.mainRead(addr, this.altzp);
    if (addr < 0xC000) return this.mainRead(addr, this.usesAux(addr, true));
    if (addr < 0xC100) return 0;
    if (addr < 0xD000) return this.cxRead(addr, false);
    if (this.lcRead) {
      const bank = this.lcBank();
      return bank ? bank[this.lcIndex(addr)] : 0xFF;
    }
    return this.rom[addr - 0xD000];
  }

  override snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    for (let addr = 0; addr < 0x10000; addr++) out[addr] = this.peek(addr);
    return out;
  }

  /** A IIe system ROM is 16K, $C000-$FFFF; a 32K image (two copies) is read from
   *  its start. */
  override loadRom(data: Uint8Array): void {
    this.rom.fill(0);
    this.intRom.fill(0xFF);
    if (data.length >= 0x4000) {
      this.intRom.set(data.subarray(0, 0x1000));
      this.rom.set(data.subarray(0x1000, 0x4000));
    } else {
      this.rom.set(data.subarray(0, 0x3000));
    }
  }

  /**
   * Apply one of the MMU switches. `n` counts them in address order from $C000
   * (80STORE, RAMRD, RAMWRT, INTCXROM, ALTZP, SLOTC3ROM); returns false for the
   * switches the machine owns (80COL, ALTCHARSET).
   */
  setMmuSwitch(n: number, on: boolean): boolean {
    switch (n) {
      case 0: this.store80 = on; return true;
      case 1: this.ramrd = on; return true;
      case 2: this.ramwrt = on; return true;
      case 3: this.intcxrom = on; return true;
      case 4: this.altzp = on; return true;
      case 5: this.slotc3rom = on; return true;
      default: return false;
    }
  }

  override reset(): void {
    super.reset();
    this.store80 = false;
    this.ramrd = false;
    this.ramwrt = false;
    this.intcxrom = false;
    this.altzp = false;
    this.slotc3rom = false;
    this.intc8rom = false;
    this.page2 = false;
    this.hires = false;
  }
}
