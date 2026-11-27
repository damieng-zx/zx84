/**
 * Oric on-demand inspection: the memory-layout pane, and the BASIC listing and
 * variables detokenised with the keyword table read from the resident ROM.
 *
 * Separate from the frame probe because these are asked for on demand and may
 * allocate, while `sample()` runs every rAF and must not.
 */

import type { BasicListingLine } from '@/basic/types.ts';
import type { MachineInspection } from '@/machines/machine.ts';
import {
  parseOricBasic, parseOricBasicVariables, readOricTokenTable, type OricTokenTable,
} from '@/basic/oric-basic-parser.ts';
import type { OricMachine } from '../oric-machine.ts';

export class OricInspection implements MachineInspection {
  /** The keyword table, read once per ROM content (see `tokens()`). */
  private tokenTable: OricTokenTable | null = null;
  private tokenStamp = '';

  constructor(private readonly machine: OricMachine) {}

  memoryMap() { return this.machine.memoryMap(); }

  basicListing(): BasicListingLine[] {
    return parseOricBasic(this.machine.memory.ram, this.tokens());
  }

  basicVars() { return parseOricBasicVariables(this.machine.memory.ram); }

  /**
   * The ROM's own keyword table, cached against the ROM *contents*.
   *
   * The array identity cannot be the key: `memory.rom` is one array for the
   * life of the machine and loadROM copies into it, so `tokenRom !== rom` was
   * never true and a machine that loaded a different ROM kept the first one's
   * keyword table. A cheap content stamp (length plus a few sampled bytes) does
   * change when the ROM is replaced.
   */
  private tokens(): OricTokenTable {
    const rom = this.machine.memory.rom;
    const stamp = romStamp(rom);
    if (this.tokenTable === null || this.tokenStamp !== stamp) {
      this.tokenTable = readOricTokenTable(rom);
      this.tokenStamp = stamp;
    }
    return this.tokenTable;
  }
}

/** A ROM's length and a handful of sampled bytes, enough to notice a reload. */
function romStamp(rom: Uint8Array): string {
  let h = rom.length;
  // Every 512th byte: the keyword table spans the ROM, so a replaced image
  // differs somewhere. The loop is ~32 steps for a 16K ROM.
  for (let i = 0; i < rom.length; i += 512) h = (h * 31 + rom[i]) | 0;
  return `${rom.length}:${h}`;
}
