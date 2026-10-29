/**
 * zx84's native Commodore 64 snapshot (`.c64state`).
 *
 * The shared native container (`machines/shared/native-state.ts`, magic
 * 'ZX64') around the machine's own sections, written by
 * `C64Machine.saveState`:
 *
 *   CPU   the 6510 (`M6502.saveState`)
 *   MACH  f64 frame start, f64 frame end, f64 frame number, bool NMI line
 *   MEM   64K RAM, colour RAM, the 6510 port (direction, data, floating
 *         bits) and the VIC-II bank
 *   VIC   the VIC-II's registers, counters, border and sprite state
 *   SID   the SID's voices and filter registers
 *   CIA1  CIA 1 (`Mos6526.saveState`)
 *   CIA2  CIA 2
 *   CART  (optional, after MACH) the cartridge: its `.crt` file and board state
 *   TV    (optional, after MACH) 1 byte: NTSC
 *
 * The HEAD carries three ROM CRCs: BASIC, KERNAL, character ROM. The tape is
 * not part of the state.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';

export const C64_STATE: NativeStateSpec = {
  ext: '.c64state',
  magic: 'ZX64',
  version: 1,
  machineName: 'Commodore 64',
  maxBody: 1 << 22,
  modelName: model => (model === 'c64' ? 'Commodore 64' : null),
};
