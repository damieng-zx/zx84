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
  /** The keyword table, read once from the resident ROM (it never changes). */
  private tokenTable: OricTokenTable | null = null;
  private tokenRom: Uint8Array | null = null;

  constructor(private readonly machine: OricMachine) {}

  memoryMap() { return this.machine.memoryMap(); }

  basicListing(): BasicListingLine[] {
    return parseOricBasic(this.machine.memory.ram, this.tokens());
  }

  basicVars() { return parseOricBasicVariables(this.machine.memory.ram); }

  /** The ROM's own keyword table, cached against the ROM it came from. */
  private tokens(): OricTokenTable {
    const rom = this.machine.memory.rom;
    if (this.tokenTable === null || this.tokenRom !== rom) {
      this.tokenTable = readOricTokenTable(rom);
      this.tokenRom = rom;
    }
    return this.tokenTable;
  }
}
