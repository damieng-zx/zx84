/**
 * Spectrum peripheral-ROM requests. Each fitted peripheral (VTX-5000, Multiface,
 * MGT +D, ZX Interface 1, Beta Disk) contributes an AuxRomRequest the shell
 * fetches/caches and wires back through `apply`. The machine owns all the
 * peripheral-specific knowledge (which CDN URL, which cache key, the status text,
 * and how the bytes land in its chip); the shell owns only the generic mechanics.
 *
 * This is where the shell's former per-machine peripheral-ROM cascade lives now.
 * The per-peripheral builders are exported for the Hardware pane's live-enable
 * path (via the shell's thin loadXxxROM wrappers); `buildSpectrumAuxRoms` bundles
 * them for the build-time `prepare()` hook, adding enable-flag + mutual-exclusion
 * logic and the write-protect defaults.
 */

import type { AuxRomRequest, SettingsView } from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import type { SpectrumModel } from '@/machines/spectrum/models.ts';
import { isPlusDCapable, isInterface1Capable, isBetaDiskCapable } from '@/machines/spectrum/models.ts';
import { variantForModel, variantLabel, romFilename } from '@/machines/spectrum/peripherals/multiface.ts';

const ROM_CDN = 'https://zx84files.bitsparse.com/roms/';
const VTX5000_ROM_URL = `${ROM_CDN}vtx5000-3-1.rom`;
const PLUSD_ROM_URL = `${ROM_CDN}plusd.rom`;
const BETADISK_ROM_URL = `${ROM_CDN}trdos.rom`;
const IF1_ROM_URL = `${ROM_CDN}if1-2.rom`;

export function vtx5000AuxRom(m: Spectrum): AuxRomRequest {
  return {
    cacheKey: 'vtx5000-rom', url: VTX5000_ROM_URL,
    fetchingMsg: 'Fetching VTX-5000 ROM…',
    loadedMsg: (n) => `VTX-5000 ROM loaded (${n} bytes)`,
    failMsg: 'Failed to load VTX-5000 ROM', failId: 'vtx5000',
    apply: (d) => m.vtx5000.loadROM(d), awaitLoad: true,
  };
}

/** Multiface — variant is fixed by model (set as a side-effect here, as the old
 *  loader did); the ROM load is fire-and-forget (paged only on the button). */
export function multifaceAuxRom(m: Spectrum): AuxRomRequest {
  const variant = variantForModel(m.model as SpectrumModel);
  m.multiface.variant = variant;
  return {
    cacheKey: `mf-rom-${variant}`, url: ROM_CDN + romFilename(variant),
    fetchingMsg: `Fetching ${variantLabel(variant)} ROM...`,
    loadedMsg: (n) => `${variantLabel(variant)} ROM loaded (${n} bytes)`,
    failMsg: `Failed to load ${variantLabel(variant)} ROM`, failId: 'multiface',
    apply: (d) => m.multiface.loadROM(d), awaitLoad: false,
  };
}

export function plusDAuxRom(m: Spectrum): AuxRomRequest {
  return {
    cacheKey: 'plusd-rom', url: PLUSD_ROM_URL,
    fetchingMsg: 'Fetching MGT +D ROM…',
    loadedMsg: (n) => `MGT +D ROM loaded (${n} bytes)`,
    failMsg: 'Failed to load MGT +D ROM', failId: 'plusd',
    apply: (d) => m.mgtPlusD.loadROM(d), awaitLoad: true,
  };
}

export function if1AuxRom(m: Spectrum): AuxRomRequest {
  return {
    cacheKey: 'if1-rom', url: IF1_ROM_URL,
    fetchingMsg: 'Fetching ZX Interface 1 ROM…',
    loadedMsg: (n) => `ZX Interface 1 ROM loaded (${n} bytes)`,
    failMsg: 'Failed to load ZX Interface 1 ROM', failId: 'interface1',
    apply: (d) => m.interface1.loadROM(d), awaitLoad: true,
  };
}

export function betaAuxRom(m: Spectrum): AuxRomRequest {
  return {
    cacheKey: 'betadisk-rom', url: BETADISK_ROM_URL,
    fetchingMsg: 'Fetching TR-DOS ROM…',
    loadedMsg: (n) => `Beta Disk TR-DOS ROM loaded (${n} bytes)`,
    failMsg: 'Failed to load Beta Disk (TR-DOS) ROM', failId: 'betadisk',
    apply: (d) => m.betaDisk.loadROM(d), awaitLoad: true,
  };
}

/**
 * Configure the Spectrum's fitted peripherals from the settings view (enable
 * flags + write-protects, set synchronously) and return the peripheral-ROM loads
 * the shell must fulfil before the system ROM is loaded and the machine reset.
 * Behaviour matches the old emulator.createMachine() peripheral block exactly,
 * including ordering (VTX, Multiface, +D, IF1, Beta) and the +D/IF1/Beta
 * mutual-exclusion (Beta wins).
 */
export function buildSpectrumAuxRoms(m: Spectrum, view: SettingsView): AuxRomRequest[] {
  const model = m.model as SpectrumModel;
  const reqs: AuxRomRequest[] = [];

  m.vtx5000.enabled = view.get('vtx5000', false);
  if (m.vtx5000.enabled) reqs.push(vtx5000AuxRom(m));

  // Variant is fixed by model regardless of the enable flag (matches the old
  // createMachine, which set it unconditionally before the enable check).
  m.multiface.variant = variantForModel(model);
  m.multiface.enabled = view.get('multiface', false);
  if (m.multiface.enabled) reqs.push(multifaceAuxRom(m));

  // Beta, +D and IF1 all overlay slot 0 — only one may be active; Beta wins.
  const betaActive = view.get('betadisk', false) && isBetaDiskCapable(model);

  m.mgtPlusD.enabled = !betaActive && view.get('plusd', false) && isPlusDCapable(model);
  if (m.mgtPlusD.enabled) {
    m.mgtPlusD.fdc.writeProtect[0] = view.get('write-protect-c', false);
    m.mgtPlusD.fdc.writeProtect[1] = view.get('write-protect-d', false);
    reqs.push(plusDAuxRom(m));
  }

  m.interface1.enabled = !betaActive && view.get('interface1', false) && isInterface1Capable(model);
  if (m.interface1.enabled) reqs.push(if1AuxRom(m));

  m.betaDisk.enabled = betaActive;
  if (m.betaDisk.enabled) {
    m.betaDisk.fdc.writeProtect[0] = view.get('write-protect-c', false);
    m.betaDisk.fdc.writeProtect[1] = view.get('write-protect-d', false);
    reqs.push(betaAuxRom(m));
  }

  return reqs;
}
