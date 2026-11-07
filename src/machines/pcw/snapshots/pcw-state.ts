/**
 * zx84's native Amstrad PCW snapshot (`.pcwstate`).
 *
 * The shared native container (`machines/shared/native-state.ts`, magic
 * 'ZXPC') around the machine's own sections, written by
 * `PcwMachine.saveState`:
 *
 *   CONF  u8 fitted drive count — a mismatch is refused
 *   CPU   the Z80 (`Z80.saveState`)
 *   MACH  f64 frame start, frame end and frame number (the beam grid); the
 *         beeper bit, booted and reboot-requested flags, the FDC /NMI edge
 *         latch and the end of the current 300Hz timer pulse
 *   MEM   the &F0-&F3 bank registers, &F4, and every fitted 16K block
 *   ASIC  roller base and offset, &F7 video control, screen on/off, the timer
 *         pulse and its 4-bit counter, FDC interrupt routing and line, raster line
 *   KBD   SHIFT LOCK and the &3FFF update toggle (held keys are released)
 *   MEDA  bool: discs follow — per fitted drive, its name and the whole image
 *         (`writeDskImage`); a refresh state has none, the shell remounts them
 *   FDC   the uPD765A (`UPD765A.saveState`), a transfer in flight included
 *
 * The model is in the HEAD; there is no ROM to checksum (the PCW boots from
 * disc and its bootstrap is native code), so the HEAD's ROM list is empty.
 * Write protect is a setting and is not part of the state.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';
import type { MachineModel } from '@/models.ts';
import { isPcwModel, type PcwModel } from '../models.ts';

const NAMES: Record<PcwModel, string> = {
  pcw8256: 'Amstrad PCW 8256',
  pcw8512: 'Amstrad PCW 8512',
  pcw9512: 'Amstrad PCW 9512',
  pcw9256: 'Amstrad PCW 9256',
};

export const PCW_STATE: NativeStateSpec = {
  ext: '.pcwstate',
  magic: 'ZXPC',
  version: 1,
  machineName: 'Amstrad PCW',
  // 512K of RAM and two 720K discs, with room for flux-sourced bitstreams.
  maxBody: 16 << 20,
  modelName: model => (isPcwModel(model as MachineModel) ? NAMES[model as PcwModel] : null),
};
