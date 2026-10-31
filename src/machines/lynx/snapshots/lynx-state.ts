/**
 * zx84's native Camputers Lynx snapshot (`.lynxstate`).
 *
 * The shared native container (`machines/shared/native-state.ts`, magic
 * 'ZXLX') around the machine's own sections, written by
 * `LynxMachine.saveState`:
 *
 *   CONF  bool disk interface fitted, u8 drives fitted — a mismatch is refused
 *   CPU   the Z80 (`Z80.saveState`)
 *   MACH  f64 frame start, f64 frame end, f64 frame number (the beam grid)
 *   MEM   user RAM, video RAM, the 128K's extra RAM, then the bank port,
 *         port 0x80 and port 0x58 as the bank decode last saw them
 *   VID   the 6845 (`Crtc6845.saveState`)
 *   PORT  u8 port 0x80, u8 DAC level, bool cassette motor relay
 *   MEDA  bool media; with media, the four drives: image (`writeDskImage`),
 *         name and write-protect tab
 *   FDC   the FD1793 (`WD179x.saveState`)
 *
 * The HEAD carries one ROM CRC: the whole ROM store (system images and DOS
 * ROM). The model (and with it the RAM fitted) is in the HEAD; a state for
 * another Lynx asks for that model. The cassette is not part of the state.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';

const NAMES: Record<string, string> = {
  lynx48: 'Camputers Lynx 48K',
  lynx96: 'Camputers Lynx 96K',
  lynx128: 'Camputers Lynx 128K',
};

export const LYNX_STATE: NativeStateSpec = {
  ext: '.lynxstate',
  magic: 'ZXLX',
  version: 1,
  machineName: 'Camputers Lynx',
  // 192K of RAM and four 800K disks, generously.
  maxBody: 8 << 20,
  modelName: model => NAMES[model] ?? null,
};
