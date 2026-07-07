/**
 * MachineVariant for the 16K Spectrum (Issue 1/2, Ferranti ULA).
 *
 * Identical to the 48K hardware-wise — same ULA, same ROM, same timings —
 * but only the lower 16KB of RAM is fitted (bank 5 at 0x4000-0x7FFF).
 * The upper 32KB (0x8000-0xFFFF) is unconnected: reads return 0xFF (open
 * bus) and writes are discarded.
 */

import { TIMING_48K } from '@/contention.ts';
import type { MachineVariant } from './machine-variant.ts';

/** Ferranti ULA contention pattern: 6,5,4,3,2,1,0,0 */
const CONTENTION_FERRANTI = new Uint8Array([6, 5, 4, 3, 2, 1, 0, 0]);

export const spectrum16K: MachineVariant = Object.freeze({
  model: '16k' as const,
  timing: TIMING_48K,

  cellRenderOffset: 1,
  vramFlushEnd: 0x5B00,

  contentionPattern: CONTENTION_FERRANTI,
  hasIOContention: true,
  hasFloatingBus: true,

  isContended(addr: number, _currentBank: number): boolean {
    // Same as 48K: only the populated 16KB at 0x4000-0x7FFF is contended.
    return addr >= 0x4000 && addr < 0x8000;
  },

  hasAY: false,
  hasBanking: false,
  hasFDC: false,
  hasSpecialPaging: false,
  romPageCount: 1,
  // Treat as 48K-class for tape compatibility: "stop-if-48k" tape blocks
  // signal that 128K-only content follows, which a 16K can't run either.
  is48K: true,

  decodes7FFD(_port: number): boolean { return false; },
  decodes1FFD(_port: number): boolean { return false; },
  decodesFDCData(_port: number): boolean { return false; },
  decodesFDCStatus(_port: number): boolean { return false; },
});
