/**
 * BBC Micro Model B memory map.
 *
 *   0x0000-0x7FFF  32K RAM
 *   0x8000-0xBFFF  sideways ROM selected by the ROMSEL latch (0xFE30); ROM 15
 *                  is BASIC on a standard machine
 *   0xC000-0xFBFF  OS ROM
 *   0xFC00-0xFEFF  memory-mapped hardware (1 MHz bus + "sheila"); addresses the
 *                  machine's IO decoder does not claim fall through to OS ROM
 *   0xFF00-0xFFFF  OS ROM
 *
 * The machine installs `ioRead`/`ioWrite` hooks for the hardware window.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import { BBC_ROM_SIZE } from './models.ts';

const RAM_SIZE = 0x8000;
const ROM_SOCKETS = 16;

export class BbcMemory implements IMachineMemory {
  /** 0x0000-0x7FFF, split into two 16K banks for the debug memory pane. */
  readonly ram = new Uint8Array(RAM_SIZE);
  /** Sixteen 16K sideways-ROM sockets. */
  readonly roms: Uint8Array[] = Array.from({ length: ROM_SOCKETS }, () => new Uint8Array(BBC_ROM_SIZE));
  /** 0xC000-0xFFFF OS ROM. */
  readonly osRom = new Uint8Array(BBC_ROM_SIZE);

  /** ROMSEL latch (0xFE30). Bit 7 enables the selected socket; low nibble is
   *  the ROM number. Defaults to BASIC in socket 15. */
  romsel = 0x0F;

  /** Hardware window read hook; returns -1 for an address it does not claim. */
  ioRead: (addr: number) => number = () => -1;
  /** Hardware window write hook. */
  ioWrite: (addr: number, val: number) => void = () => {};

  get ramBankCount(): number { return 2; }

  getRamBank(n: number): Uint8Array {
    const bank = n & 1;
    return this.ram.subarray(bank * 0x4000, (bank + 1) * 0x4000);
  }

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr < 0x8000) return this.ram[addr];
    if (addr < 0xC000) return this.roms[this.romsel & 0x0F][addr & 0x3FFF];
    if (addr >= 0xFC00 && addr < 0xFF00) {
      const v = this.ioRead(addr);
      if (v >= 0) return v & 0xFF;
    }
    return this.osRom[addr & 0x3FFF];
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    val &= 0xFF;
    if (addr < 0x8000) { this.ram[addr] = val; return; }
    if (addr < 0xC000) return; // sideways ROM: writes ignored
    if (addr >= 0xFC00 && addr < 0xFF00) { this.ioWrite(addr, val); return; }
    // 0xC000-0xFBFF / 0xFF00-0xFFFF: OS ROM, writes ignored.
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte((addr + i) & 0xFFFF);
    return out;
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    out.set(this.ram, 0x0000);
    out.set(this.roms[this.romsel & 0x0F], 0x8000);
    out.set(this.osRom, 0xC000);
    return out;
  }

  /** Load a concatenated system ROM: 16K OS followed by 16K BASIC. */
  loadRom(data: Uint8Array): void {
    if (data.length >= BBC_ROM_SIZE) this.osRom.set(data.subarray(0, BBC_ROM_SIZE));
    if (data.length >= BBC_ROM_SIZE * 2) this.roms[0x0F].set(data.subarray(BBC_ROM_SIZE, BBC_ROM_SIZE * 2));
  }

  /** Install a sideways ROM into a socket. */
  loadSidewaysRom(socket: number, data: Uint8Array): void {
    this.roms[socket & 0x0F].set(data.subarray(0, BBC_ROM_SIZE));
  }

  reset(): void {
    this.romsel = 0x0F;
  }
}
