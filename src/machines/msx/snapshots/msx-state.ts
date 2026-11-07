/**
 * zx84's native MSX snapshot (`.msxstate`).
 *
 * The shared native container (`machines/shared/native-state.ts`, magic
 * 'ZXMS') around the machine's own sections, written by
 * `MsxMachine.saveState`:
 *
 *   CONF  bool disk interface fitted, u8 drive count — a mismatch is refused
 *   CPU   the Z80 (`Z80.saveState`; the M1 wait state is wiring, not state)
 *   MACH  f64 frame start, f64 frame end, f64 frame number, bool kana LED
 *   MEM   the RAM, the primary-slot register, the four expansion registers,
 *         then the slot-1 cartridge: image, mapper and each 8KB segment's
 *         mega-ROM bank (-1 = unmapped); then the cartridge's name
 *   PPI   port A and port C output latches
 *   VDP   the TMS9918A (`Tms9918a.saveState`)
 *   PSG   the AY-3-8910 (`AY3891x.saveState`), registers 14/15 included
 *   DISK  (empty without the disk interface) bool disks (always true as
 *         written); per drive: bool loaded, str name, the disk
 *         (`writeDskImage`); then the card's drive/side/motor latch, INTRQ and
 *         the WD2793
 *
 * The HEAD carries three ROM CRCs: BIOS/BASIC, on-board firmware, Disk BASIC
 * (0 where absent). The cartridge and the disks are in every state, the
 * browser-refresh one too, because the shell does not bring an MSX cartridge
 * or disk back after a reload (the MSX does not persist its media). The
 * cassette (.cas) is not part of the state.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';

const MODEL_NAMES: Readonly<Record<string, string>> = {
  'hx-10': 'Toshiba HX-10',
  'hb-55': 'Sony HB-55',
  'hb-55p': 'Sony HB-55P',
};

export const MSX_STATE: NativeStateSpec = {
  ext: '.msxstate',
  magic: 'ZXMS',
  version: 1,
  machineName: 'MSX',
  // 64K RAM, a 2MB mega-ROM and two 720K disks, generously.
  maxBody: 16 << 20,
  modelName: model => MODEL_NAMES[model] ?? null,
};
