/**
 * Apple II / II Plus memory map.
 *
 *   0x0000-0xBFFF  48K RAM
 *   0x0000-0xC0FF  soft switches and slot I/O ("$C0xx"), decoded by the machine
 *   0xC100-0xC7FF  peripheral-card ROM, 256 bytes per slot (slot 6 = Disk II)
 *   0xC800-0xCFFF  expansion ROM (unused here)
 *   0xD000-0xFFFF  system ROM (Applesoft + Monitor), 12K
 *
 * The machine installs the `ioRead`/`ioWrite` hooks for the $C0xx window; reads
 * and writes there are the switch side effects, so anything that must not touch
 * hardware (the debug snapshot) bypasses them.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import { APPLE2_ROM_SIZE } from './models.ts';

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
    if (addr < 0xC800) {
      const rom = this.slotRom[(addr >> 8) & 0x07];
      return rom ? rom[addr & 0xFF] : 0xFF;
    }
    if (addr < 0xD000) return 0xFF;                 // expansion ROM: none fitted
    return this.rom[addr - ROM_BASE];
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    if (addr < 0xC000) { this.ram[addr] = val & 0xFF; return; }
    if (addr < 0xC100) { this.ioWrite(addr, val & 0xFF); return; }
    // Slot ROM, expansion ROM and system ROM ignore writes.
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
    out.fill(0xFF, 0xC800, 0xD000);
    out.set(this.rom, ROM_BASE);
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

  /** A reset (Ctrl-Reset) preserves RAM and the fitted card ROMs — the ROM's
   *  cold start clears only the few bytes it needs — so there is nothing
   *  machine-wide to wipe here. */
  reset(): void {}
}
