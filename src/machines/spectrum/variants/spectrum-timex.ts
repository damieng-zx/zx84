/**
 * MachineVariant for the Timex Computer 2048: a 48K-class machine (16K ROM, 48K
 * RAM, no banking) whose ULA is the Timex SCLD. The SCLD contends memory with
 * the Ferranti pattern but has no floating bus (unattached ports read 0xFF),
 * decodes its ports on the low eight address bits, and adds the screen modes
 * and the interrupt-disable bit of port 0xFF (see scld.ts).
 */

import { TIMING_TC2048 } from '@/machines/spectrum/contention.ts';
import type { MachineVariant } from './machine-variant.ts';

/** The SCLD contends like the Ferranti ULA: 6,5,4,3,2,1,0,0 */
const CONTENTION_SCLD = new Uint8Array([6, 5, 4, 3, 2, 1, 0, 0]);

export const spectrumTc2048: MachineVariant = Object.freeze({
  model: 'tc2048' as const,
  timing: TIMING_TC2048,

  contentionPattern: CONTENTION_SCLD,
  hasIOContention: true,
  hasFloatingBus: false,
  hasGateArrayFloatingBus: false,

  isContended(addr: number, _currentBank: number): boolean {
    // Like the 48K: the 16K from 0x4000 (both screens) is contended.
    return addr >= 0x4000 && addr < 0x8000;
  },

  hasAY: false,
  hasBanking: false,
  hasFDC: false,
  hasSpecialPaging: false,
  romPageCount: 1,
  is48K: true,

  decodes7FFD(_port: number): boolean { return false; },
  decodes1FFD(_port: number): boolean { return false; },
  decodesEFF7(_port: number): boolean { return false; },
  decodesFDCData(_port: number): boolean { return false; },
  decodesFDCStatus(_port: number): boolean { return false; },
});
