/**
 * zx84's native Jupiter Ace snapshot (`.acestate`).
 *
 * The shared native container (`machines/shared/native-state.ts`, magic
 * 'ZXJA') around the machine's own sections, written by
 * `JupiterAceMachine.saveState`:
 *
 *   CONF  u8 RAM pack size in KB (0, 16 or 48) — a mismatch is refused
 *   CPU   the Z80 (`Z80.saveState`)
 *   MACH  f64 frame start, f64 frame end, f64 frame number (the beam grid)
 *   MEM   1K video RAM, 1K character RAM, 1K main RAM, then the RAM pack
 *   ULA   u8 MIC bit, u8 buzzer flip-flop
 *
 * The HEAD carries one ROM CRC (the 8K FORTH ROM). The cassette is not part
 * of the state.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';

export const ACE_STATE: NativeStateSpec = {
  ext: '.acestate',
  magic: 'ZXJA',
  version: 1,
  machineName: 'Jupiter Ace',
  maxBody: 1 << 20,
  modelName: model => (model === 'jupiter-ace' ? 'Jupiter Ace' : null),
};
