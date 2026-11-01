/**
 * zx84's native Commodore VIC-20 snapshot (`.vic20state`).
 *
 * The shared native container (`machines/shared/native-state.ts`, magic
 * 'ZX20') around the machine's own sections, written by
 * `Vic20Machine.saveState`:
 *
 *   CONF  bool NTSC, then the expansion RAM fitted: RAM1-3, BLK1, BLK2,
 *         BLK3, BLK5 (a restore refuses a mismatch before changing anything)
 *   CPU   the 6502 (`M6502.saveState`)
 *   MACH  f64 frame start, f64 frame end, f64 frame number, bool NMI line
 *   MEM   the 64K RAM array and the colour RAM
 *   VIC   the VIC's registers, bus byte and the frame's text-row state
 *   SND   the VIC's voices: counters, shift registers, noise LFSR, clock
 *   VIA1  VIA 1 (`M6522.saveState`)
 *   VIA2  VIA 2
 *
 * The HEAD carries three ROM CRCs: BASIC, KERNAL, character ROM.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';
import { isVic20Model } from '../models.ts';

export const VIC20_STATE: NativeStateSpec = {
  ext: '.vic20state',
  magic: 'ZX20',
  version: 1,
  machineName: 'Commodore VIC-20',
  maxBody: 1 << 20,
  modelName: model => (isVic20Model(model) ? 'Commodore VIC-20' : null),
};
