/**
 * zx84's native Enterprise 64/128 snapshot (`.epstate`).
 *
 * The shared native container (`machines/shared/native-state.ts`, magic
 * 'ZXEP') around the machine's own sections, written by
 * `EnterpriseMachine.saveState`:
 *
 *   CONF  bool EXDOS card fitted, u8 drives fitted — a mismatch is refused
 *   CPU   the Z80 (`Z80.saveState`)
 *   MACH  the frame grid (f64 start, end, number), the frame-buffer row and
 *         VSYNC edge Nick's lines are counted from, the typer (keyboard
 *         row last selected, queued steps, hold, frames left, typed keys)
 *   MEM   the RAM and the four page registers
 *   NICK  Nick's registers, palette and place in the line parameter table
 *   DAVE  Dave's counters, channels, timebase and interrupt latches
 *   FILE  the FILE: device's files and open channels (always: the files are
 *         host-side, so nothing else would bring them back)
 *   MEDA  bool disks carried, then per drive: in, name, write protect and,
 *         when carried, the disk (`writeDskImage`)
 *   EXDS  the EXDOS card: the WD1770 and the card's latch (when fitted)
 *
 * The HEAD carries seven ROM CRCs: EXOS, the BASIC cartridge, EXDOS and the
 * four extension sockets (0 for an empty one).
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';

const NAMES: Record<string, string> = { ep64: 'Enterprise 64', ep128: 'Enterprise 128' };

export const EP_STATE: NativeStateSpec = {
  ext: '.epstate',
  magic: 'ZXEP',
  version: 1,
  machineName: 'Enterprise',
  // 128K of RAM, four 720K disks and a FILE: bundle, generously.
  maxBody: 16 << 20,
  modelName: model => NAMES[model] ?? null,
};
