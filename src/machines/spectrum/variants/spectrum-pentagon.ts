/**
 * MachineVariant for the Pentagon 128: 128K banking and AY, but none of the
 * Sinclair ULA's memory contention, and no floating bus.
 */

import type { MachineVariant } from './machine-variant.ts';
import { TIMING_PENTAGON } from '@/machines/spectrum/contention.ts';

/** No contention: every access runs at full speed. */
const CONTENTION_NONE = new Uint8Array(8);

export const spectrumPentagon: MachineVariant = Object.freeze({
  model: 'pentagon128' as const,
  timing: TIMING_PENTAGON,

  cellRenderOffset: 0 as const,
  vramFlushEnd: 0x5800,

  contentionPattern: CONTENTION_NONE,
  hasIOContention: false,
  // Unattached ports read 0xFF on the Pentagon; there is no ULA bus snoop.
  hasFloatingBus: false,
  hasGateArrayFloatingBus: false,

  isContended(_addr: number, _bank: number): boolean { return false; },

  hasAY: true,
  hasBanking: true,
  hasFDC: false,
  hasSpecialPaging: false,
  romPageCount: 2,
  is48K: false,

  // Same loose 128K decode as the Sinclair: A15 and A1 low.
  decodes7FFD(port: number): boolean { return (port & 0x8002) === 0; },
  decodes1FFD(_port: number): boolean { return false; },
  decodesFDCData(_port: number): boolean { return false; },
  decodesFDCStatus(_port: number): boolean { return false; },
});
