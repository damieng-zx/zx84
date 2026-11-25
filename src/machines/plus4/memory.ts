/**
 * Commodore Plus/4 (and C16) memory: the 7501's 64K map, the ROM bank the TED
 * switches, and the RAM size a C16 has.
 *
 *   $0000-$00FF  the 7501's page: $00 the data direction, $01 the port
 *   $0100-$7FFF  RAM
 *   $8000-$BFFF  ROM bank low (BASIC, the 3+1 ROM, a cartridge, or RAM)
 *   $C000-$FBFF  ROM bank high (KERNAL, the 3+1 ROM, a cartridge, or RAM)
 *   $FC00-$FCFF  the KERNAL, always (its bank-switching routines live there)
 *   $FD00-$FD0F  the 6551A ACIA (Plus/4; the RAM under it on a C16)
 *   $FD10-$FD1F  6529B PIO 1, the user port
 *   $FD30-$FD3F  6529B PIO 2, the keyboard rows
 *   $FDD0-$FDDF  ROM bank select: `$FDD0 + low + 4 * high`
 *   $FEE0-$FEFF  a 1551's TIA (only with that drive)
 *   $FF00-$FF3F  the TED's 64 registers
 *   $FF40-$FFFF  RAM, or the KERNAL (its top 16K) while the ROM is selected
 *
 * `$FF3F` written banks the ROMs out over `$8000-$FFFF` entirely (RAM mode):
 * only the two 256-byte pages of I/O, the 7501's page and the bank-select
 * register stay. `$FF3E` brings them back. That is how the KERNAL frees the
 * 60K BASIC gets with no ROM fitted.
 *
 * Two quirks the KERNAL and BASIC lean on:
 *
 *  - A write to a ROM address always reaches the RAM under it (a write
 *    "bleeds through"), even while the ROM answers reads there.
 *  - The C16's 16K is mirrored four times across the map, so the whole 64K
 *    the 7501 can address answers with RAM.
 *
 * The character set is inside the KERNAL image; the TED reads it through the
 * same map (`readByte`), so a banked-out ROM hides it there too, as on the
 * chip.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import type { Plus4Model } from './models.ts';
import { plus4RamSize } from './models.ts';

/** ROM bank select: the four code pairs `$FDD0 | (low << 0) | (high << 2)`. */
export const ROM_LOW_BASIC = 0;
export const ROM_LOW_FUNC = 1;
export const ROM_LOW_CART = 2;
export const ROM_HIGH_KERNAL = 0;
export const ROM_HIGH_FUNC = 1;
export const ROM_HIGH_CART = 2;

export type IoRead = (addr: number) => number;
export type IoWrite = (addr: number, value: number) => void;

export class Plus4Memory implements IMachineMemory {
  readonly model: Plus4Model;
  /** The whole 64K, so RAM sits at its own address; a C16's 16K is mirrored. */
  readonly ram = new Uint8Array(0x10000);
  /** The KERNAL (16K), BASIC (16K) and, on the Plus/4, the 3+1 function ROMs. */
  readonly kernal = new Uint8Array(0x4000);
  readonly basic = new Uint8Array(0x4000);
  readonly funcLow = new Uint8Array(0x4000);
  readonly funcHigh = new Uint8Array(0x4000);
  /** The cartridge's ROM banks, when one is fitted. */
  readonly cartLow = new Uint8Array(0x4000);
  readonly cartHigh = new Uint8Array(0x4000);
  cartFitted = false;
  /** Which system ROMs are actually installed. An uninstalled one does not
   *  answer, so a write to its address shows the RAM beneath. */
  private readonly romLoaded = { kernal: false, basic: false, funcLow: false, funcHigh: false };

  /** Whether the ROMs answer (`$FF3E`) or the RAM does (`$FF3F`). */
  romVisible = true;
  /** The bank select value: bit 0-1 low bank, bit 2-3 high bank (`$FDD0`). */
  bankSelect = 0;
  /** The 7501's own port, and its data direction. */
  portDir = 0;
  portData = 0;

  /** The I/O handlers the machine wires: $FD00-$FDFF and $FF00-$FF3F. */
  ioRead: IoRead = () => 0xFF;
  ioWrite: IoWrite = () => {};
  ioPeek: IoRead = () => 0xFF;
  /** What a read of an empty place finds (the last byte on the bus). */
  openBus: () => number = () => 0xFF;
  /** The 7501 port's pins: a read of `$01`, and a write to it, go through here. */
  onPortRead: () => number = () => 0xFF;
  onPortWrite: (value: number) => void = () => {};


  constructor(model: Plus4Model) {
    this.model = model;
    this.setRamSize(plus4RamSize(model));
    this.reset();
  }

  /** Fit `size` bytes of RAM, mirrored across the 64K (the C16's 16K repeats
   *  four times). */
  private setRamSize(size: number): void {
    const pages = Math.max(1, size >> 10);
    // The mirror mask the addresses are ANDed with: 16K → $3FFF, 64K → $FFFF.
    this.ramMirrorMask = pages >= 64 ? 0xFFFF : (pages << 10) - 1;
  }

  /** The mask RAM addresses are mirrored with: 0 for a full 64K, 0x3FFF for a
   *  C16's 16K. */
  private ramMirrorMask = 0;

  /** Power-on: RAM in the pattern the DRAMs settle into. */
  reset(): void {
    for (let i = 0; i < 0x10000; i++) this.ram[i] = (i & 0x08) === 0 ? 0x00 : 0xFF;
    this.romVisible = true;
    this.bankSelect = 0;
    this.portDir = 0;
    this.portData = 0;
    this.cartFitted = false;
  }

  // ── ROM banks ───────────────────────────────────────────────────────────

  /** The ROM bank the select register names for `$8000-$BFFF`. */
  private get lowBank(): Uint8Array | null {
    if (!this.romVisible) return null;
    switch (this.bankSelect & 3) {
      case ROM_LOW_BASIC: return this.romLoaded.basic ? this.basic : null;
      case ROM_LOW_FUNC: return this.romLoaded.funcLow ? this.funcLow : null;
      case ROM_LOW_CART: return this.cartFitted ? this.cartLow : null;
      default: return null;
    }
  }

  /** The ROM bank the select register names for `$C000-$FFFF`. */
  private get highBank(): Uint8Array | null {
    if (!this.romVisible) return null;
    switch ((this.bankSelect >> 2) & 3) {
      case ROM_HIGH_KERNAL: return this.romLoaded.kernal ? this.kernal : null;
      case ROM_HIGH_FUNC: return this.romLoaded.funcHigh ? this.funcHigh : null;
      case ROM_HIGH_CART: return this.cartFitted ? this.cartHigh : null;
      default: return null;
    }
  }

  /** Install the system ROM: KERNAL, BASIC and (on the Plus/4) the 3+1 ROMs,
   *  in the order the ROM host serves them. */
  loadRoms(kernal: Uint8Array | null, basic: Uint8Array | null,
    funcLow: Uint8Array | null = null, funcHigh: Uint8Array | null = null): void {
    if (kernal) { this.kernal.set(kernal.subarray(0, 0x4000)); this.romLoaded.kernal = true; }
    if (basic) { this.basic.set(basic.subarray(0, 0x4000)); this.romLoaded.basic = true; }
    if (funcLow) { this.funcLow.set(funcLow.subarray(0, 0x4000)); this.romLoaded.funcLow = true; }
    if (funcHigh) { this.funcHigh.set(funcHigh.subarray(0, 0x4000)); this.romLoaded.funcHigh = true; }
  }

  /** Fit a cartridge's two 16K banks (null takes it out). */
  setCartridge(low: Uint8Array | null, high: Uint8Array | null): void {
    this.cartFitted = low !== null || high !== null;
    if (low) this.cartLow.set(low.subarray(0, 0x4000));
    if (high) this.cartHigh.set(high.subarray(0, 0x4000));
  }

  /** Bank the ROMs in or out over `$8000-$FFFF` (`$FF3E` / `$FF3F`). */
  setRomVisible(on: boolean): void { this.romVisible = on; }

  /** Write the bank select register (`$FDD0`-`$FDDF`). */
  setBank(value: number): void { this.bankSelect = value & 0x1F; }

  // ── RAM ────────────────────────────────────────────────────────────────


  /** The RAM cell an address maps to (a C16's 16K mirrors). */
  private ramIndex(addr: number): number { return addr & this.ramMirrorMask; }

  /** The RAM size fitted, in bytes. */
  get ramSize(): number { return this.ramMirrorMask + 1; }

  // ── CPU bus ──────────────────────────────────────────────────────────────

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr < 0x100) {
      if (addr === 0) return this.portDir;
      if (addr === 1) return this.onPortRead();
    }
    if (addr >= 0xFD00 && addr < 0xFE00) return this.ioRead(addr);
    if (addr >= 0xFF00) {
      if (addr < 0xFF40) return this.ioRead(addr);
      const bank = this.highBank;
      if (bank) return bank[addr & 0x3FFF];
      return this.ram[this.ramIndex(addr)];
    }
    if (addr >= 0xFC00) {
      // The KERNAL's top page is always there for its bank-switching routines.
      if (addr < 0xFD00) return this.kernal[addr & 0x3FFF];
      return this.openBus();
    }
    const bank = addr >= 0x8000 ? (addr < 0xC000 ? this.lowBank : this.highBank) : null;
    if (bank) return bank[addr & 0x3FFF];
    if (addr >= 0x8000 && addr < 0xC000) return this.ram[this.ramIndex(addr)];
    return this.ram[this.ramIndex(addr)];
  }

  writeByte(addr: number, value: number): void {
    addr &= 0xFFFF;
    const v = value & 0xFF;
    if (addr < 0x100) {
      if (addr === 0) { this.portDir = v & 0xDF; return; }
      if (addr === 1) { this.portData = v; this.onPortWrite(v); return; }
    }
    if (addr >= 0xFF00) {
      if (addr < 0xFF40) { this.ioWrite(addr, v); return; }
      // A write to the ROM always bleeds through to the RAM under it.
      this.ram[this.ramIndex(addr)] = v;
      return;
    }
    if (addr >= 0xFD00 && addr < 0xFE00) { this.ioWrite(addr, v); return; }
    if (addr >= 0xFC00) { this.ram[this.ramIndex(addr)] = v; return; }
    if (addr >= 0x8000) {
      // A write to a banked ROM reaches the RAM beneath.
      this.ram[this.ramIndex(addr)] = v;
      return;
    }
    this.ram[this.ramIndex(addr)] = v;
  }

  /** What the CPU would read, without I/O side effects (for the debugger). */
  peekByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr < 0x100) {
      if (addr === 0) return this.portDir;
      if (addr === 1) return this.onPortRead();
    }
    if (addr >= 0xFD00 && addr < 0xFE00) return this.ioPeek(addr);
    if (addr >= 0xFF00) {
      if (addr < 0xFF40) return this.ioPeek(addr);
      const bank = this.highBank;
      if (bank) return bank[addr & 0x3FFF];
      return this.ram[this.ramIndex(addr)];
    }
    if (addr >= 0xFC00) return this.kernal[addr & 0x3FFF];
    const bank = addr >= 0x8000 ? (addr < 0xC000 ? this.lowBank : this.highBank) : null;
    if (bank) return bank[addr & 0x3FFF];
    if (addr >= 0x8000) return this.ram[this.ramIndex(addr)];
    return this.ram[this.ramIndex(addr)];
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.peekByte((addr + i) & 0xFFFF);
    return out;
  }

  /** A whole 64K view as the CPU sees it (I/O peeked). */
  snapshot(): Uint8Array { return this.readBlock(0, 0x10000); }

  get ramBankCount(): number { return 4; }

  /** One 16K quarter of the address space's RAM array, live. */
  getRamBank(n: number): Uint8Array {
    // A C16's 16K is the only bank there is; every index is that one.
    if (this.ramMirrorMask === 0x3FFF) return this.ram.subarray(0, 0x4000);
    const bank = (((n % 4) + 4) % 4) << 14;
    return this.ram.subarray(bank, bank + 0x4000);
  }

  // ── Snapshots ───────────────────────────────────────────────────────────

  saveState(w: StateWriter): void {
    w.raw(this.ram);
    w.bool(this.romVisible); w.u8(this.bankSelect);
    w.u8(this.portDir); w.u8(this.portData); w.bool(this.cartFitted);
    for (const k of ['kernal', 'basic', 'funcLow', 'funcHigh'] as const) w.bool(this.romLoaded[k]);
  }

  loadState(r: StateReader): void {
    r.rawInto(this.ram);
    this.romVisible = r.bool(); this.bankSelect = r.u8();
    this.portDir = r.u8(); this.portData = r.u8(); this.cartFitted = r.bool();
    for (const k of ['kernal', 'basic', 'funcLow', 'funcHigh'] as const) this.romLoaded[k] = r.bool();
  }
}
