/**
 * NewBrainMemory — the unexpanded NewBrain's address space.
 *
 * 32K of RAM below 8000, three 8K ROM sockets from A000 and nothing in
 * between. Until the board's power-up timer expires the decode forces the top
 * ROM bank (the one at E000) over every address and switches RAM off, which is
 * how the Z80 finds code at 0000 after reset. The video circuit reads the same
 * RAM the CPU does, so there is no separate video memory.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { NB_RAM_SIZE, NB_ROM_SIZE, NB_COP_ROM_SIZE, NB_CHAR_ROM_SIZE } from './constants.ts';

/** Offset of the E000 bank inside the 24K ROM image. */
const TOP_BANK = 0x4000;

export class NewBrainMemory implements IMachineMemory {
  private rom = new Uint8Array(NB_ROM_SIZE);
  private cop = new Uint8Array(NB_COP_ROM_SIZE);
  private chars = new Uint8Array(NB_CHAR_ROM_SIZE);
  readonly ram = new Uint8Array(NB_RAM_SIZE);

  /** False until the power-up timer expires: the top bank shadows everything. */
  poweredUp = false;

  /**
   * Install the combined system image: 24K of Z80 ROM (A000, C000, E000
   * banks), then the 1K COP420 firmware, then the 4K character generator. A
   * bare 24K image keeps the COP firmware and character ROM already loaded
   * (there are none by default, and the machine then cannot boot).
   */
  loadROM(data: Uint8Array): void {
    this.rom = new Uint8Array(NB_ROM_SIZE);
    this.rom.set(data.subarray(0, NB_ROM_SIZE));
    if (data.length >= NB_ROM_SIZE + NB_COP_ROM_SIZE) {
      this.cop = new Uint8Array(NB_COP_ROM_SIZE);
      this.cop.set(data.subarray(NB_ROM_SIZE, NB_ROM_SIZE + NB_COP_ROM_SIZE));
    }
    if (data.length >= NB_ROM_SIZE + NB_COP_ROM_SIZE + NB_CHAR_ROM_SIZE) {
      this.chars = new Uint8Array(NB_CHAR_ROM_SIZE);
      this.chars.set(data.subarray(NB_ROM_SIZE + NB_COP_ROM_SIZE, NB_ROM_SIZE + NB_COP_ROM_SIZE + NB_CHAR_ROM_SIZE));
    }
  }

  getRom(): Uint8Array { return this.rom; }
  getCopRom(): Uint8Array { return this.cop; }
  getCharRom(): Uint8Array { return this.chars; }

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (!this.poweredUp) return this.rom[TOP_BANK + (addr & 0x1FFF)];
    if (addr < NB_RAM_SIZE) return this.ram[addr];
    if (addr >= 0xA000) return this.rom[addr - 0xA000];
    return 0xFF;   // 8000-9FFF: nothing fitted, the expansion bus floats high
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    if (this.poweredUp && addr < NB_RAM_SIZE) this.ram[addr] = val & 0xFF;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte((addr + i) & 0xFFFF);
    return out;
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    for (let i = 0; i < 0x10000; i++) out[i] = this.readByte(i);
    return out;
  }

  getRamBank(_n: number): Uint8Array { return this.ram; }
  readonly ramBankCount = 1;

  reset(): void {
    this.ram.fill(0);
    this.poweredUp = false;
  }

  saveState(w: StateWriter): void {
    w.bool(this.poweredUp);
    w.raw(this.ram);
  }

  loadState(r: StateReader): void {
    this.poweredUp = r.bool();
    r.rawInto(this.ram);
  }
}
