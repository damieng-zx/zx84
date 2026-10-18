/**
 * MachineVariant factory for the Pentagon family: 128K banking and AY, but none
 * of the Sinclair ULA's memory contention, and no floating bus. The 512 and 1024
 * share the 128's timing and differ only in how much RAM they page and which
 * ports they decode (see SpectrumMemory.bankFor7FFD for the page number).
 */

import type { SpectrumModel } from '@/models.ts';
import type { MachineVariant } from './machine-variant.ts';
import { TIMING_PENTAGON } from '@/machines/spectrum/contention.ts';

/** No contention: every access runs at full speed. */
const CONTENTION_NONE = new Uint8Array(8);

export function createPentagon(model: 'pentagon128' | 'pentagon512' | 'pentagon1024'): MachineVariant {
  return Object.freeze({
    model: model as SpectrumModel,
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

    // The 128 and 512 decode 7FFD loosely (A15 and A1 low). The 1024 also
    // requires A14 high, so 0x3FFD-style addresses no longer page memory.
    decodes7FFD(port: number): boolean {
      return model === 'pentagon1024' ? (port & 0xC002) === 0x4000 : (port & 0x8002) === 0;
    },
    decodes1FFD(_port: number): boolean { return false; },
    // 1024 control port: A15-A12 = 1110 and A3 = 0 (0xEFF7 is the canonical write).
    decodesEFF7(port: number): boolean {
      return model === 'pentagon1024' && (port & 0xF008) === 0xE000;
    },
    decodesFDCData(_port: number): boolean { return false; },
    decodesFDCStatus(_port: number): boolean { return false; },
  });
}
