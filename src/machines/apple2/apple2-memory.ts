/**
 * Apple II / II Plus memory map.
 *
 *   0x0000-0xBFFF  48K RAM
 *   0x0000-0xC0FF  soft switches and slot I/O ("$C0xx"), decoded by the machine
 *   0xC100-0xC7FF  peripheral-card ROM, 256 bytes per slot (slot 6 = Disk II)
 *   0xC800-0xCFFF  expansion ROM (unused here)
 *   0xD000-0xFFFF  system ROM (Applesoft + Monitor), 12K, or the 16K language
 *                  card's RAM when it is switched in ($C080-$C08F)
 *
 * The machine installs the `ioRead`/`ioWrite` hooks for the $C0xx window; reads
 * and writes there are the switch side effects, so anything that must not touch
 * hardware (the debug snapshot) bypasses them.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import type { Apple2Card } from './cards.ts';
import { APPLE2_ROM_SIZE } from './models.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

const RAM_SIZE = 0xC000;
const ROM_BASE = 0xD000;
const BANK_SIZE = 0x4000;

export class Apple2Memory implements IMachineMemory {
  /** 48K RAM, split into three 16K banks for the debug memory tools. */
  readonly ram = new Uint8Array(RAM_SIZE);
  /** System ROM at $D000-$FFFF. */
  readonly rom = new Uint8Array(APPLE2_ROM_SIZE);
  /** Peripheral-card ROM per slot (index 1-7; slot 0 is the language card). */
  readonly slotRom: (Uint8Array | null)[] = new Array<Uint8Array | null>(8).fill(null);
  /** Cards that answer their `$CNxx` page and `$C800` area themselves (see cards.ts). */
  readonly cards: (Apple2Card | null)[] = new Array<Apple2Card | null>(8).fill(null);
  /** Slot whose expansion area currently owns `$C800-$CFFF`; 0 for none. */
  protected expansionOwner = 0;

  /**
   * Language card: 16K of RAM that overlays the system ROM at $D000-$FFFF —
   * two 4K banks sharing the $D000-$DFFF window plus 8K at $E000-$FFFF. Laid out
   * as bank 1 (4K), bank 2 (4K), then the common 8K.
   */
  readonly lcRam = new Uint8Array(0x4000);
  protected lcRead = false;       // reads at $D000+ come from the card's RAM
  protected lcWrite = false;      // writes at $D000+ land in the card's RAM
  protected lcBank2 = true;       // $D000-$DFFF window shows bank 2
  protected lcPrewrite = false;   // the first of the two reads that enable writing
  /** Whether the card is fitted; without it the switches do nothing. */
  languageCard = true;

  /** Whether $D000-$FFFF currently reads the language card's RAM (status reads). */
  get lcReadsRam(): boolean { return this.lcRead; }
  /** Whether the $D000 window shows bank 2 (status reads). */
  get lcBank2Selected(): boolean { return this.lcBank2; }

  /** Auxiliary RAM, or null on machines without it. Only the IIe has any. */
  readonly aux: Uint8Array | null = null;

  /** The byte on the data bus when nothing drives it, for a read of `addr`: the
   *  one the video scanner has just fetched. The machine supplies it (it knows
   *  the beam); a bare memory reads high. */
  floatingBus: (addr: number) => number = () => 0xFF;
  /** $C0xx switch/slot hook; returns -1 for an address it does not claim. */
  ioRead: (addr: number) => number = () => -1;
  /** $C0xx switch/slot write hook. */
  ioWrite: (addr: number, val: number) => void = () => {};

  get ramBankCount(): number { return RAM_SIZE / BANK_SIZE; }

  getRamBank(n: number): Uint8Array {
    const bank = ((n % this.ramBankCount) + this.ramBankCount) % this.ramBankCount;
    return this.ram.subarray(bank * BANK_SIZE, (bank + 1) * BANK_SIZE);
  }

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr < 0xC000) return this.ram[addr];
    if (addr < 0xC100) {
      const v = this.ioRead(addr);
      return v >= 0 ? v & 0xFF : 0xFF;
    }
    if (addr < 0xD000) return this.cxPeripheralRead(addr, true);
    if (this.lcRead) return this.lcRam[this.lcIndex(addr)];
    return this.rom[addr - ROM_BASE];
  }

  /**
   * `$C100-$CFFF` as the peripheral cards present it: a card's own page if it
   * answers there, else the slot ROM image; and `$C800-$CFFF` from whichever card
   * owns the expansion area. `latch` is false for a side-effect-free peek.
   */
  protected cxPeripheralRead(addr: number, latch: boolean): number {
    if (addr < 0xC800) {
      const slot = (addr >> 8) & 7;
      const card = this.cards[slot];
      if (card && latch) {
        if (card.hasExpansion) this.expansionOwner = slot;
        const v = card.pageRead ? card.pageRead(addr & 0xFF) : -1;
        if (v >= 0) return v & 0xFF;
      }
      const rom = this.slotRom[slot];
      return rom ? rom[addr & 0xFF] : latch ? this.floatingBus(addr) : 0xFF;
    }
    const card = this.expansionOwner ? this.cards[this.expansionOwner] : null;
    let v = -1;
    if (card?.expansionRead && latch) v = card.expansionRead(addr - 0xC800);
    if (addr === 0xCFFF && latch) this.expansionOwner = 0;
    return v >= 0 ? v & 0xFF : latch ? this.floatingBus(addr) : 0xFF;
  }

  protected cxPeripheralWrite(addr: number, val: number): void {
    if (addr < 0xC800) {
      const slot = (addr >> 8) & 7;
      const card = this.cards[slot];
      if (card) {
        if (card.hasExpansion) this.expansionOwner = slot;
        card.pageWrite?.(addr & 0xFF, val);
      }
      return;
    }
    const card = this.expansionOwner ? this.cards[this.expansionOwner] : null;
    card?.expansionWrite?.(addr - 0xC800, val);
    if (addr === 0xCFFF) this.expansionOwner = 0;
  }

  /** Offset into {@link lcRam} for an address at or above $D000. */
  protected lcIndex(addr: number): number {
    if (addr >= 0xE000) return 0x2000 + (addr - 0xE000);
    return (this.lcBank2 ? 0x1000 : 0x0000) + (addr - 0xD000);
  }

  /**
   * An access to one of the sixteen language-card switches ($C080-$C08F).
   * Bit 3 picks the $D000 bank (0 = bank 2); the low two bits pick the mode —
   * 0 read RAM / no write, 1 read ROM / write, 2 read ROM / no write, 3 read RAM
   * / write — and the writing modes (odd addresses) only take effect after two
   * consecutive *reads*; a write access in between starts the count again.
   */
  lcAccess(n: number, isRead: boolean): void {
    if (!this.languageCard) return;
    n &= 0x0F;
    this.lcBank2 = (n & 8) === 0;
    const mode = n & 3;
    this.lcRead = mode === 0 || mode === 3;
    if ((n & 1) === 0) {
      this.lcWrite = false;
      this.lcPrewrite = false;
    } else if (isRead) {
      if (this.lcPrewrite) this.lcWrite = true;
      this.lcPrewrite = true;
    } else {
      this.lcPrewrite = false;
    }
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    if (addr < 0xC000) { this.ram[addr] = val & 0xFF; return; }
    if (addr < 0xC100) { this.ioWrite(addr, val & 0xFF); return; }
    if (addr < 0xD000) { this.cxPeripheralWrite(addr, val & 0xFF); return; }
    // Slot ROM, expansion ROM and system ROM ignore writes; the language card's
    // RAM, when write-enabled, takes them whichever side is being read.
    if (addr >= ROM_BASE && this.lcWrite) this.lcRam[this.lcIndex(addr)] = val & 0xFF;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte((addr + i) & 0xFFFF);
    return out;
  }

  /** Side-effect-free 64K view: the $C0xx window reads as 0 rather than
   *  triggering switches (a snapshot must not clear the keyboard strobe). */
  snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    out.set(this.ram, 0x0000);
    for (let slot = 1; slot <= 7; slot++) {
      const rom = this.slotRom[slot];
      if (rom) out.set(rom, 0xC000 + slot * 0x100);
    }
    for (let a = 0xC800; a < 0xD000; a++) out[a] = 0xFF;
    out.set(this.rom, ROM_BASE);
    if (this.lcRead) {
      out.set(this.lcRam.subarray(this.lcBank2 ? 0x1000 : 0x0000, (this.lcBank2 ? 0x1000 : 0x0000) + 0x1000), 0xD000);
      out.set(this.lcRam.subarray(0x2000, 0x4000), 0xE000);
    }
    return out;
  }

  /** Install a system ROM image. A 12K image fills $D000-$FFFF directly; a
   *  larger (16K) image is truncated to its top 12K, which is the part a II/II+
   *  maps there. */
  loadRom(data: Uint8Array): void {
    this.rom.fill(0);
    if (data.length >= 0x4000) {
      this.rom.set(data.subarray(data.length - APPLE2_ROM_SIZE));
    } else {
      this.rom.set(data.subarray(0, APPLE2_ROM_SIZE));
    }
  }

  /** Install a peripheral-card ROM into a slot. */
  loadSlotRom(slot: number, data: Uint8Array): void {
    if (slot < 1 || slot > 7) return;
    const rom = new Uint8Array(0x100);
    rom.set(data.subarray(0, 0x100));
    this.slotRom[slot] = rom;
  }

  /** A reset (Ctrl-Reset) preserves RAM (the language card's too) and the fitted
   *  card ROMs — the ROM's cold start clears only the few bytes it needs — but
   *  puts the language card back to reading ROM with writes protected. */
  reset(): void {
    this.expansionOwner = 0;
    for (const card of this.cards) card?.reset?.();
    this.lcRead = false;
    this.lcWrite = false;
    this.lcBank2 = true;
    this.lcPrewrite = false;
  }

  // ── Snapshot state ────────────────────────────────────────────────────────

  /** Write main RAM, the language card's RAM and switches, and which card
   *  owns the expansion area. Slot ROMs are firmware, not state. */
  saveState(w: StateWriter): void {
    w.raw(this.ram);
    w.raw(this.lcRam);
    w.bool(this.lcRead); w.bool(this.lcWrite); w.bool(this.lcBank2); w.bool(this.lcPrewrite);
    w.u8(this.expansionOwner);
  }

  loadState(r: StateReader): void {
    r.rawInto(this.ram);
    r.rawInto(this.lcRam);
    this.lcRead = r.bool(); this.lcWrite = r.bool(); this.lcBank2 = r.bool(); this.lcPrewrite = r.bool();
    this.expansionOwner = r.u8() & 7;
  }
}
