/**
 * Spectrum Hardware-pane actions (plain TS so headless tests can import them
 * without a DOM): the peripheral-ROM loads for the live-enable path and the
 * Multiface NMI button. Machine-owned — reaches the Spectrum's own peripherals
 * directly; the shell contributes only the generic aux-ROM loader and handles.
 */

import { spectrum, loadAuxRom, setStatus } from '@/emulator.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import {
  multifaceAuxRom, vtx5000AuxRom, plusDAuxRom, if1AuxRom, betaAuxRom,
} from '@/machines/spectrum/aux-roms.ts';

export const loadMultifaceROM = (s: Spectrum) => loadAuxRom(multifaceAuxRom(s));
export const loadVTX5000ROM = (s: Spectrum) => loadAuxRom(vtx5000AuxRom(s));
export const loadPlusDROM = (s: Spectrum) => loadAuxRom(plusDAuxRom(s));
export const loadInterface1ROM = (s: Spectrum) => loadAuxRom(if1AuxRom(s));
export const loadBetaDiskROM = (s: Spectrum) => loadAuxRom(betaAuxRom(s));

/** Press the Multiface's red button (NMI). */
export function triggerNMI(): void {
  if (!spectrum) return;
  const mf = spectrum.multiface;
  if (!mf.enabled) { setStatus('Multiface not enabled'); return; }
  if (!mf.romLoaded) { setStatus('Multiface ROM not loaded'); return; }
  mf.pressButton(spectrum.memory, spectrum.cpu, spectrum.memory.slot0Bank);
  setStatus('Multiface NMI triggered');
}
