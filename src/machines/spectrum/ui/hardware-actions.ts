/**
 * Spectrum Hardware-pane actions (plain TS so headless tests can import them
 * without a DOM): the peripheral-ROM loads for the live-enable path and the
 * Multiface NMI button. Machine-owned — reaches the Spectrum's own peripherals
 * directly; the shell contributes only the generic aux-ROM loader and handles.
 */

import { loadAuxRom } from '@/shell/rom.ts';
import { setStatus } from '@/shell/context.ts';
import { activeSpectrum } from '@/machines/spectrum/ui/active.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import {
  multifaceAuxRom, vtx5000AuxRom, plusDAuxRom, plusDSystemAuxRom, if1AuxRom, betaAuxRom, uspeechAuxRoms,
} from '@/machines/spectrum/aux-roms.ts';

export const loadMultifaceROM = (s: Spectrum) => loadAuxRom(multifaceAuxRom(s));
export const loadVTX5000ROM = (s: Spectrum) => loadAuxRom(vtx5000AuxRom(s));
/** Fetch whichever +D images are missing: the ROM, then the optional G+DOS
 *  system file. Resolves to whether the ROM is present (the +D works without
 *  the system file). */
export async function loadPlusDROM(s: Spectrum): Promise<boolean> {
  if (!s.mgtPlusD.romLoaded && !(await loadAuxRom(plusDAuxRom(s)))) return false;
  if (s.mgtPlusD.systemFile === null) await loadAuxRom(plusDSystemAuxRom(s));
  return true;
}
export const loadInterface1ROM = (s: Spectrum) => loadAuxRom(if1AuxRom(s));
export const loadBetaDiskROM = (s: Spectrum) => loadAuxRom(betaAuxRom(s));
/** Fetch both µSpeech images; true only if both arrived. */
export async function loadUspeechROMs(s: Spectrum): Promise<boolean> {
  for (const r of uspeechAuxRoms(s)) if (!(await loadAuxRom(r))) return false;
  return true;
}

/** Press the Multiface's red button (NMI). */
export function triggerNMI(): void {
  const s = activeSpectrum();
  if (!s) return;
  const mf = s.multiface;
  if (!mf.enabled) { setStatus('Multiface not enabled'); return; }
  if (!mf.romLoaded) { setStatus('Multiface ROM not loaded'); return; }
  mf.pressButton(s.memory, s.cpu, s.memory.slot0Bank);
  setStatus('Multiface NMI triggered');
}

/** Press the Scorpion ZS-256's Magic button: an NMI into its service monitor
 *  (or TR-DOS, with 48K BASIC selected), taken at the next fetch from RAM. */
export function triggerScorpionMagic(): void {
  const s = activeSpectrum();
  if (!s?.scorpion) return;
  s.scorpion.pressMagic();
  setStatus('Magic button pressed');
}
