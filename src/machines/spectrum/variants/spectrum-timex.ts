/**
 * MachineVariants for the Timex machines: 48K-class machines (48K RAM, no 128K
 * banking) whose ULA is the Timex SCLD. The SCLD contends memory with the
 * Ferranti pattern but has no floating bus (unattached ports read 0xFF),
 * decodes its ports on the low eight address bits, and adds the screen modes
 * and the interrupt-disable bit of port 0xFF (see scld.ts).
 *
 * The TS2068 and TC2068 add an AY-3-8912 clocked at half the CPU clock, and a
 * 24K ROM (16K HOME plus 8K EXROM) under the horizontal memory mapper of port
 * 0xF4 (see timex-mmu.ts). They differ only in the video standard: the TS2068
 * is the US 60 Hz machine, the TC2068 the 50 Hz one, on the TC2048's timing: one
 * model, `ts2068`, whose locale picks the standard (see models.ts).
 */

import { TIMING_TC2048, TIMING_TS2068, type MachineTiming } from '@/machines/spectrum/contention.ts';
import type { MachineVariant } from './machine-variant.ts';

/** The SCLD contends like the Ferranti ULA: 6,5,4,3,2,1,0,0 */
const CONTENTION_SCLD = new Uint8Array([6, 5, 4, 3, 2, 1, 0, 0]);

function timexVariant(model: 'tc2048' | 'ts2068', timing: MachineTiming): MachineVariant {
  const is2068 = model !== 'tc2048';
  return Object.freeze({
  model,
  timing,

  contentionPattern: CONTENTION_SCLD,
  hasIOContention: true,
  hasFloatingBus: false,
  hasGateArrayFloatingBus: false,

  isContended(addr: number, _currentBank: number): boolean {
    // Like the 48K: the 16K from 0x4000 (both screens) is contended.
    return addr >= 0x4000 && addr < 0x8000;
  },

  // The AY sits at half the CPU clock: 3.528 MHz / 2.
  hasAY: is2068,
  ayClock: is2068 ? timing.cpuClock / 2 : undefined,
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
}

export const spectrumTc2048: MachineVariant = timexVariant('tc2048', TIMING_TC2048);
/** The Timex 2068 as sold in the US: NTSC, 60 Hz. */
export const spectrumTs2068Ntsc: MachineVariant = timexVariant('ts2068', TIMING_TS2068);
/** The Timex 2068 as sold in Europe (the TC2068): PAL, 50 Hz, on the TC2048's timing. */
export const spectrumTs2068Pal: MachineVariant = timexVariant('ts2068', TIMING_TC2048);
