/**
 * The Commodore 128's memory management unit (the 8722): the register file
 * at $D500-$D50B, the configuration register's mirror at $FF00 and the four
 * "load configuration" addresses $FF01-$FF04, and what those registers say
 * about the memory map. The map itself (what is ROM, RAM or I/O where) is
 * `memory.ts`'s; this is the state it reads.
 *
 * Registers (C128 Programmer's Reference Guide, "The MMU registers"):
 *
 *   $D500 CR    configuration. Bit 0 chooses I/O (0) or ROM/RAM (1) at
 *               $D000-$DFFF. Bit 1 chooses low BASIC ROM (0) or RAM (1) at
 *               $4000-$7FFF. Bits 3-2 choose, at $8000-$BFFF, high BASIC ROM
 *               (00), internal function ROM (01), external function ROM (10) or
 *               RAM (11). Bits 5-4 do the same at $C000-$FFFF for the system
 *               ROM (editor, KERNAL). Bits 7-6 are the RAM block.
 *   $D501-$D504 PCRA-PCRD, four preconfigurations. Writing the address
 *               $FF01-$FF04 (any value) loads one into CR.
 *   $D505 MCR   mode. Bit 0 chooses the CPU (1 the 8502, 0 the Z80). Bit 3 is
 *               the fast serial direction (1 output). Bit 6 chooses C64 mode.
 *               Read: bits 4 and 5 are the levels of the cartridge port's
 *               /GAME and /EXROM pins (1 with nothing plugged in: the BIOS
 *               takes a 0 for a cartridge), and bit 7 is the 40/80 DISPLAY
 *               key (1 = released, the 40-column display).
 *   $D506 RCR   RAM configuration. Bits 1-0 choose the size of the common RAM
 *               (1K, 4K, 8K, 16K); bit 2 puts it at the bottom, bit 3 at the
 *               top, of the 64K. Bits 7-6 are the RAM block the VIC-IIe sees.
 *   $D507-$D50A P0L, P0H, P1L, P1H: where pages 0 and 1 of the CPU are
 *               relocated to (a page, and the RAM block). The high byte is
 *               latched and takes effect when the low byte is written; its
 *               unused upper bits read as 1.
 *   $D50B       the MMU's version, 0.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

/** RAM blocks on a 128: two 64K blocks. */
export const C128_RAM_BLOCKS = 2;

/** What `$D50B` reads: version 0 in the low nybble (the upper nybble reads the
 *  number of 64K blocks on a machine that has more than two: 2 here). */
const MMU_VERSION = 0x20;

export class Mmu {
  /** The configuration register and its four preconfigurations. */
  cr = 0;
  readonly pcr = new Uint8Array(4);
  /** The mode register as stored (bits 4-5 are always 1; they read as the cartridge lines). */
  mcr = 0x30;
  rcr = 0;
  /** Page 0 and page 1 relocation: the page, and the high byte (its bit 0 is the RAM block). */
  p0l = 0;
  p0h = 0;
  p1l = 1;
  p1h = 0;
  private p0hLatch = 0;
  private p1hLatch = 0;

  /** The cartridge port's lines, as the pins (high = released). */
  game = true;
  exrom = true;
  /** The 40/80 DISPLAY key is up (the 40-column display). */
  displayKeyUp = true;

  /** A register changed what the map shows or which CPU runs; `fastSerialDir`
   *  is MCR bit 3, which the serial bus follows. */
  onChange: (() => void) | null = null;
  onCpuChange: ((to8502: boolean) => void) | null = null;
  onFastSerialDir: ((out: boolean) => void) | null = null;

  reset(): void {
    this.cr = 0;
    this.pcr.fill(0);
    this.mcr = 0x30;
    this.rcr = 0;
    this.p0l = 0; this.p0h = 0;
    this.p1l = 1; this.p1h = 0;
    this.p0hLatch = 0; this.p1hLatch = 0;
  }

  // ── What the registers say ──────────────────────────────────────────────

  /** The 8502 is the CPU in charge (the Z80 otherwise). */
  get cpu8502(): boolean { return (this.mcr & 0x01) !== 0; }
  /** The machine is in C64 mode. */
  get c64Mode(): boolean { return (this.mcr & 0x40) !== 0; }
  /** The fast serial port is an output (the computer sends). */
  get fastSerialOut(): boolean { return (this.mcr & 0x08) !== 0; }
  /** The RAM block the CPU sees (0 or 1). */
  get ramBlock(): number { return (this.cr >> 6) & 1; }
  /** The RAM block the VIC-IIe sees (0 or 1). */
  get vicBlock(): number { return (this.rcr >> 6) & 1; }

  /** Size of the common RAM in bytes. */
  get commonSize(): number {
    const n = this.rcr & 3;
    return n === 0 ? 0x400 : 0x1000 << (n - 1);
  }
  /** The common RAM at the bottom of the address space ends before this address; 0 for none. */
  get bottomCommonEnd(): number { return (this.rcr & 4) !== 0 ? this.commonSize : 0; }
  /** The common RAM at the top begins at this address; 0x10000 for none. */
  get topCommonStart(): number { return (this.rcr & 8) !== 0 ? 0x10000 - this.commonSize : 0x10000; }

  /** The RAM address ($00000-$1FFFF) a CPU address in `block` lands on: the
   *  common RAM is always block 0. */
  ramAddress(addr: number, block: number): number {
    if (addr < this.bottomCommonEnd || addr >= this.topCommonStart) return addr;
    return (block << 16) | addr;
  }

  // ── Registers ───────────────────────────────────────────────────────────

  /** A read of a register (0-$B; the rest of the page reads $FF). */
  read(reg: number): number {
    switch (reg) {
      case 0: return this.cr;
      case 1: case 2: case 3: case 4: return this.pcr[reg - 1];
      case 5:
        return (this.mcr & 0x4F)
          | (this.game ? 0x10 : 0) | (this.exrom ? 0x20 : 0)
          | (this.displayKeyUp ? 0x80 : 0);
      case 6: return this.rcr;
      case 7: return this.p0l;
      case 8: return this.p0h | 0xF0;
      case 9: return this.p1l;
      case 10: return this.p1h | 0xF0;
      case 11: return MMU_VERSION;
      default: return 0xFF;
    }
  }

  write(reg: number, value: number): void {
    const v = value & 0xFF;
    switch (reg) {
      case 0: this.cr = v; break;
      case 1: case 2: case 3: case 4: this.pcr[reg - 1] = v; break;
      case 5: {
        const old = this.mcr;
        this.mcr = (v & 0x7F) | 0x30;
        if (((old ^ this.mcr) & 0x01) !== 0) this.onCpuChange?.((this.mcr & 1) !== 0);
        if (((old ^ this.mcr) & 0x08) !== 0) this.onFastSerialDir?.((this.mcr & 8) !== 0);
        break;
      }
      case 6: this.rcr = v; break;
      case 7: this.p0l = v; this.p0h = this.p0hLatch; break;
      case 8: this.p0hLatch = v & 0x0F; break;
      case 9: this.p1l = v; this.p1h = this.p1hLatch; break;
      case 10: this.p1hLatch = v & 0x0F; break;
      default: return;            // the version is read-only; the rest is not there
    }
    this.onChange?.();
  }

  // ── Snapshot ────────────────────────────────────────────────────────────

  saveState(w: StateWriter): void {
    w.u8(this.cr); w.raw(this.pcr);
    w.u8(this.mcr); w.u8(this.rcr);
    w.u8(this.p0l); w.u8(this.p0h); w.u8(this.p1l); w.u8(this.p1h);
    w.u8(this.p0hLatch); w.u8(this.p1hLatch);
  }

  /** Read the registers back. The owner follows up with whatever they steer
   *  (the CPU in charge, the fast serial direction, the map). */
  loadState(r: StateReader): void {
    this.cr = r.u8(); r.rawInto(this.pcr);
    this.mcr = r.u8() | 0x30; this.rcr = r.u8();
    this.p0l = r.u8(); this.p0h = r.u8(); this.p1l = r.u8(); this.p1h = r.u8();
    this.p0hLatch = r.u8(); this.p1hLatch = r.u8();
  }

  /** A read of $FF00-$FF04: CR, then the four preconfigurations. */
  readFF(addr: number): number { return this.read(addr & 0x0F); }

  /** A write of $FF00-$FF04: $FF00 is CR, and a write to $FF01-$FF04, whatever
   *  the value, loads that preconfiguration into CR. */
  writeFF(addr: number, value: number): void {
    const n = addr & 0x0F;
    if (n === 0) this.write(0, value);
    else this.write(0, this.pcr[n - 1]);
  }

  // ── Page 0 and page 1 ───────────────────────────────────────────────────

  /** Pages 0 and 1 are where they were at reset (page 0 and page 1 of block 0). */
  get relocated(): boolean {
    return this.p0l !== 0 || (this.p0h & 1) !== 0 || this.p1l !== 1 || (this.p1h & 1) !== 0;
  }

  /**
   * Whether the CPU would read RAM of `block` at `page`: the page is in a part
   * of the map that CR points at RAM, in the block the CPU is looking at.
   * Relocation swaps a page it is aimed at back with page 0 or 1 only while
   * that page is RAM in view.
   */
  private pageIsRam(page: number, block: number): boolean {
    if (block !== this.ramBlock) return false;
    if (page <= 0x3F) return true;
    if (page <= 0x7F) return (this.cr & 0x02) !== 0;
    if (page <= 0xBF) return ((this.cr >> 2) & 3) === 3;
    const ramAtTop = ((this.cr >> 4) & 3) === 3;
    if (page <= 0xCF) return ramAtTop;
    if (page <= 0xDF) return (this.cr & 0x01) !== 0 && ramAtTop;       // $D000-$DFFF
    return page <= 0xFE && ramAtTop;                                   // $FF00 holds the MMU
  }

  /**
   * Where an access of the CPU to a RAM address really goes, once page 0 or
   * page 1 has been relocated (or in C64 mode, whatever the pointers say): the
   * RAM address ($00000-$1FFFF), or -1 when the address is not affected. A
   * relocated page is swapped with the page it was sent to, so the old page 0
   * shows up where page 0 went. The 8502's own port ($00 and $01) is never
   * moved; the Z80 (`z80`) has no port, so nothing is exempt.
   *
   * The order of the arms is the hardware's (the VICE test programs, which run
   * on real machines, pin it down): the stack (P1) wins over page 0 when both
   * name the same page, the common RAM arms come before the unshared ones, and
   * the swap back only happens in the RAM block the CPU is looking at. In C64
   * mode the pointers do not move page 0/1 forward (the registers are out of
   * reach), but what was set before the switch still swaps the target pages
   * back; the caller applies that only where the 64's map shows RAM.
   *
   * A read of page 0 uses its own, shorter chain than every other access
   * (a quirk the swap tests show: page 0 reads see P0 even where a write to the
   * same address goes elsewhere).
   */
  relocate(addr: number, write = false, z80 = false): number {
    if (addr < 2 && !z80) return -1;
    const apage = addr >> 8, pos = addr & 0xFF;
    const c64 = this.c64Mode;
    const cur = this.ramBlock;
    const p0 = this.p0l, p1 = this.p1l;
    const b0 = this.p0h & 1, b1 = this.p1h & 1;
    const shared = (this.rcr & 4) !== 0;
    let page = apage, bank = 0;
    if (!write && apage === 0) {
      if (c64 && shared) { page = 0; bank = 0; }
      else if (c64 && p1 === 0) { page = 1; bank = cur; }
      else if (c64) { page = 0; bank = cur; }
      else if (p0 === 0 && b0 === 0) return pos;
      else if (shared) { page = p0; bank = 0; }
      else { page = p0; bank = b0; }
    } else if (c64 && apage <= 1 && shared) {
      bank = 0;
    } else if (c64 && apage === 0 && p1 === 0) {
      page = 1; bank = cur;
    } else if (c64 && apage === 1 && p1 === 0 && p0 === 1) {
      page = 0; bank = cur;
    } else if (c64 && apage <= 1) {
      bank = cur;
    } else if (p0 === 0 && p1 === 1 && b0 === 0 && b1 === 0) {
      return apage <= 1 ? (apage << 8) | pos : -1;
    } else if (shared && apage === 1) {
      page = p1; bank = 0;
    } else if (shared && apage === 0) {
      page = p0; bank = 0;
    } else if (apage === 1) {
      page = p1; bank = b1;
    } else if (apage === p1 && (c64 ? (write || b1 === cur) : this.pageIsRam(p1, b1))) {
      page = 1; bank = b1;
    } else if (apage === 0) {
      page = p0; bank = b0;
    } else if (apage === p0 && (c64 ? (write || b0 === cur) : this.pageIsRam(p0, b0))) {
      page = 0; bank = b0;
    } else {
      return -1;
    }
    return (bank << 16) | (page << 8) | pos;
  }
}
