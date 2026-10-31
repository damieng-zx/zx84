/**
 * zx84's native ZX80/ZX81 snapshot (`.zx8xstate`).
 *
 * The shared native container (`machines/shared/native-state.ts`, magic
 * 'ZX8X') around the machine's own sections, written by
 * `Zx8xMachine.saveState`:
 *
 *   CONF  u8 RAM in KB (1, or 16 with the pack), u8 graphics board (0 none,
 *         1 UDG, 2 UDG128, 3 WRX, 4 Memotech HRG, 5 QuickSilva HRG) — a
 *         mismatch is refused
 *   PERI  u8 add-ons fitted (bit 0 ZON X-81, bit 1 ZX Printer, bit 2 Chroma 81),
 *         bool vertical sync (the MIC line) on, then the state of each fitted
 *         add-on in that order: the AY (`AY3891x.saveState`), the printer
 *         (stylus/motor/latches, belt phase, the printout so far) and the
 *         Chroma 81 (control register, its 16K of RAM). A state that names an
 *         add-on this machine does not have is refused. States from before the
 *         add-ons existed have no PERI section and load as "none fitted".
 *   CPU   the Z80 (`Z80.saveState`)
 *   MACH  f64 frame start, f64 frame end, f64 frame number (the beam grid),
 *         bool NMI generator on, u8 Memotech HRG mode, bool QuickSilva mode,
 *         bool display fetched this frame
 *   MEM   the RAM, the 8K hi-res/UDG RAM, the Memotech 1K and QuickSilva 6K RAM
 *   VID   the software-video (pseudo-hi-res / UDG / WRX) row and frame capture
 *         buffers and their timing, which span frames
 *
 * The HEAD carries two ROM CRCs: the system ROM and the HRG board's ROM (0
 * when there is none). The cassette in the deck, the program shelf and the
 * MIC recording of a SAVE are the session's media, not part of the state: a
 * restore leaves the deck stopped where it is.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';

export const ZX8X_STATE: NativeStateSpec = {
  ext: '.zx8xstate',
  magic: 'ZX8X',
  version: 1,
  machineName: 'ZX80/ZX81',
  maxBody: 1 << 20,
  modelName: model => (model === 'zx80' ? 'ZX80' : model === 'zx81' ? 'ZX81' : null),
};
