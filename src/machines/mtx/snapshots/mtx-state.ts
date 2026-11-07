/**
 * zx84's native Memotech MTX snapshot (`.mtxstate`).
 *
 * The shared native container (`machines/shared/native-state.ts`, magic
 * 'ZXMT') around the machine's own sections, written by
 * `MtxMachine.saveState`:
 *
 *   CONF  u8 512K RAM expansion, u8 CP/M system, u8 FDX fitted,
 *         u8 80-column card, u8 drives fitted — a mismatch is refused
 *   CPU   the Z80 (`Z80.saveState`)
 *   MACH  f64 frame start, f64 frame end, f64 frame number (the beam grid);
 *         u8 cassette output, u8 sound latch (port 6), bool VDP /INT level
 *         as CTC channel 0 last saw it, u8 keyboard drive latch (port 5)
 *   MEM   u8 page register, u8 ROM-card subpage, u16 n, n × 16K RAM blocks,
 *         bool + bytes ROM pack, str ROM pack name
 *   VDP   TMS9929A (`Tms9918a.saveState`)
 *   PSG   SN76489A (`Sn76489.saveState`)
 *   CTC   Z80 CTC (`Z80Ctc.saveState`)
 *   80CO  80-column card: 6845, 2K character + 2K attribute RAM, latches,
 *         blink counter
 *   MEDA  for drives B: and C:: bool mounted, the disk image
 *         (`writeDskImage`), bool + str its name
 *   FDX   u8 control latch, bool INTRQ latch, WD179x (`WD179x.saveState`)
 *
 * The HEAD carries the CRCs of the five firmware ROMs (OS, BASIC, ASSEM,
 * CP/M bootstrap, FDX Disk BASIC). The disks are carried even in the
 * browser-refresh copy, since the shell does not persist MTX disks; the
 * logical `.mtx` cassette is not part of the state.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';

const NAMES: Record<string, string> = { mtx500: 'MTX500', mtx512: 'MTX512', rs128: 'RS128' };

export const MTX_STATE: NativeStateSpec = {
  ext: '.mtxstate',
  magic: 'ZXMT',
  version: 1,
  machineName: 'Memotech MTX',
  // 128K + 512K RAM, two HFE disks, generously.
  maxBody: 16 << 20,
  modelName: model => NAMES[model] ?? null,
};
