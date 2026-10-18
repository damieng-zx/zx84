/**
 * MachineVariant for the Scorpion ZS-256: 128K-style banking and AY on a
 * 224 x 312 frame, but no ULA memory contention, and four ROM pages.
 *
 * Its port decode is narrower than the Sinclair/Pentagon's: 7FFD needs A15=0,
 * A14=1, A5=1, A1=0, A0=1 and 1FFD needs A15=0, A14=0, A5=1, A1=0, A0=1, so the
 * loose 128K decode would wrongly page memory on a 1FFD write.
 */

import type { MachineVariant } from './machine-variant.ts';
import { TIMING_SCORPION } from '@/machines/spectrum/contention.ts';

/** No contention: every access runs at full speed. */
const CONTENTION_NONE = new Uint8Array(8);

export const spectrumScorpion: MachineVariant = Object.freeze({
  model: 'scorpion256' as const,
  timing: TIMING_SCORPION,

  cellRenderOffset: 0 as const,
  vramFlushEnd: 0x5800,

  contentionPattern: CONTENTION_NONE,
  hasIOContention: false,
  // The real board has an attribute floating bus on port 0xFF; not modelled.
  hasFloatingBus: false,
  hasGateArrayFloatingBus: false,

  isContended(_addr: number, _bank: number): boolean { return false; },

  hasAY: true,
  hasBanking: true,
  hasFDC: false,
  hasSpecialPaging: false,
  romPageCount: 4,
  is48K: false,

  decodes7FFD(port: number): boolean { return (port & 0xC023) === 0x4021; },
  decodes1FFD(port: number): boolean { return (port & 0xC023) === 0x0021; },
  decodesEFF7(_port: number): boolean { return false; },
  decodesFDCData(_port: number): boolean { return false; },
  decodesFDCStatus(_port: number): boolean { return false; },
});
