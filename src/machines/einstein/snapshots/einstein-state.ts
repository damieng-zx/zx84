/**
 * zx84's native Tatung Einstein snapshot (`.einstate`), for the TC-01 and the
 * Einstein 256.
 *
 * The shared native container (`machines/shared/native-state.ts`, magic
 * 'ZXEI') around the machine's own sections, written by
 * `EinsteinMachine.saveState`:
 *
 *   CONF  u8 drives fitted (1 or 2) — a mismatch is refused
 *   CPU   the Z80 (`Z80.saveState`)
 *   MACH  f64 frame start, f64 frame end, f64 frame number (the beam grid);
 *         u8 2 MHz CLK/TRG phase; bool V9938 interrupt enable (port 0x80);
 *         u8 keyboard/ADC/fire interrupt requests, u8 their enable mask;
 *         f64 cycle the ADC conversion completes (-1 = none)
 *   MEM   bool ROM overlay paged in, 64K RAM
 *   VDP   the TMS9929A (TC-01) or V9938 (256) — the model fixes which
 *   PSG   the AY-3-8910 (`AY3891x.saveState`)
 *   KBD   u8 row-select latch (AY port A), bool ALPHA LOCK latch
 *   CTC   the Z80 CTC (`Z80Ctc.saveState`)
 *   MEDA  bool carried; then per drive 0..1: bool present, str name,
 *         bool write-protect, the disk image (`writeDskImage`)
 *   FDC   the WD1770 (`WD179x.saveState`), which holds the drive-select,
 *         side and motor latches of port 0x23
 *
 * The HEAD carries one ROM CRC (the MOS). The 8251, PIO and printer are not
 * modelled, so there is nothing of theirs to keep.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';

export const EINSTEIN_STATE: NativeStateSpec = {
  ext: '.einstate',
  magic: 'ZXEI',
  version: 1,
  machineName: 'Tatung Einstein',
  // 64K RAM + 192K VRAM + two disks (an HFE bitstream each), generously.
  maxBody: 16 << 20,
  modelName: model => (model === 'einstein-tc01' ? 'Tatung Einstein TC-01'
    : model === 'einstein-256' ? 'Tatung Einstein 256' : null),
};
