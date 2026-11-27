/**
 * zx84's native Commodore Plus/4 and Commodore 16 snapshot (`.plus4state`).
 *
 * The shared native container (`machines/shared/native-state.ts`, magic 'ZX4P')
 * around the machine's own sections, written by `Plus4Machine.saveState`:
 *
 *   CPU   the 6502 (`M6502.saveState`)
 *   MACH  f64 frame start, f64 frame end, f64 frame number
 *   TV    bool NTSC (a restore refuses the other standard before changing
 *         anything)
 *   CART  the cartridge: bool fitted, its name and its two 16K banks
 *   MEM   the 64K RAM array, the ROM/RAM mode and the bank select
 *   TED   the register file, the raster counter, the interrupt flags, the
 *         cursor and keyboard latches, the three timers
 *   SND   the TED's two oscillators, the noise register and the clock
 *   PIO1  the user port (6529B)
 *   PIO2  the keyboard rows (6529B)
 *   ACIA  the 6551A (nothing in it on a C16)
 *   DRVM, DRV, MEDA  each disk drive with a DOS ROM, device 8 first
 *
 * The HEAD carries the ROM CRCs: KERNAL, BASIC and, on a Plus/4, the two 3+1
 * ROMs.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';
import { isPlus4Model } from '../models.ts';

export const PLUS4_STATE: NativeStateSpec = {
  ext: '.plus4state',
  magic: 'ZX4P',
  version: 1,
  machineName: 'Commodore Plus/4',
  maxBody: 1 << 20,
  modelName: model => (isPlus4Model(model) ? (model === 'c16' ? 'Commodore 16' : 'Commodore Plus/4') : null),
};
