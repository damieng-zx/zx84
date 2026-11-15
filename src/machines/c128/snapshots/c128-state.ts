/**
 * zx84's native Commodore 128 snapshot (`.c128state`).
 *
 * The shared native container (`machines/shared/native-state.ts`, magic
 * 'ZX28') around the machine's own sections, written by
 * `C128Machine.saveState`:
 *
 *   CPU   the 8502 (`M6502.saveState`)
 *   Z80   the Z80 (it runs only until the BIOS hands over, but its registers
 *         are what the MMU's mode register can hand back to)
 *   MACH  f64 frame start, f64 frame end, f64 frame number, bool NMI line,
 *         bool 8502 running, u8 $D02F lines, u8 $D030, bool CAPS LOCK,
 *         bool 40/80 key
 *   TV    1 byte: NTSC
 *   CART  (optional, after TV) what is on the expansion port: u8 0 nothing, 1 a
 *         64 cartridge (its `.crt` file, then its board state), 2 a function
 *         ROM (name, board, bank, Partner RAM block and RAM, 16K high, then the
 *         16K banks present, each with its number)
 *   MEM   both 64K RAM blocks, both colour RAM banks, the 8502 port, the
 *         VIC-IIe bank and the MMU's registers
 *   VDC   the 8563's registers and RAM (16K or 64K), its latches
 *   VIC   the VIC-IIe's registers, counters, border and sprite state
 *   SID   the SID's voices and filter registers
 *   CIA1  CIA 1 (`Mos6526.saveState`)
 *   CIA2  CIA 2
 *   SERI  the fast serial port: CIA 1's shift register, then each drive's
 *
 * then the drives (`CbmSerialBus.saveState`). The HEAD carries six ROM CRCs:
 * BASIC low, BASIC high, the system ROM, the character ROM, 64 BASIC and
 * 64 KERNAL. The tape is not part of the state.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';

export const C128_STATE: NativeStateSpec = {
  ext: '.c128state',
  magic: 'ZX28',
  version: 1,
  machineName: 'Commodore 128',
  maxBody: 1 << 23,
  modelName: model => (model === 'c128' ? 'Commodore 128' : null),
};
