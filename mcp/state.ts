/**
 * Singleton state for the MCP server.
 *
 * `state.spec`/`state.model`/`state.romData` are populated by `initMachine()`
 * — call (and await) it before touching the singletons.
 */

import { Spectrum } from '../src/spectrum.ts';
import { CpcMachine } from '../src/cpc/cpc-machine.ts';
import { type Machine, asSpectrum, asCpc } from '../src/machine.ts';
import { type MachineModel, type SpectrumModel, isCpcModel } from '../src/models.ts';
import { SymbolTable } from '../src/debug/symbols.ts';
import { fetchROM } from './rom-fetch.ts';
import { wireFdcLog } from './fdc-log.ts';
import { installTrapHook } from './traps.ts';
import { h16 } from './hex.ts';

interface State {
  model: MachineModel;
  spec: Machine;
  romData: Uint8Array;
}

// Populated by initMachine(); consumers must await initMachine before access.
export const state = {} as State;

export const symbols = new SymbolTable();

/** The active machine as a Spectrum, or null when a CPC is active. Spectrum-only
 *  tools use this to bail gracefully on the CPC. */
export function activeSpectrum(): Spectrum | null { return asSpectrum(state.spec); }
/** The active machine as a CpcMachine, or null otherwise. */
export function activeCpc(): CpcMachine | null { return asCpc(state.spec); }

export async function initMachine(m: MachineModel): Promise<string> {
  state.model = m;
  state.romData = await fetchROM(m);
  if (isCpcModel(m)) {
    const cpc = new CpcMachine(m, null);
    cpc.loadROM(state.romData);
    cpc.reset();
    state.spec = cpc;
  } else {
    const spec = new Spectrum(m as SpectrumModel);
    spec.scanlineAccuracy = 'low'; // Spectrum-only knob
    spec.loadROM(state.romData);
    spec.reset();
    state.spec = spec;
  }
  wireFdcLog(state.spec);
  installTrapHook(state.spec);
  return `Machine ready: ${m.toUpperCase()} PC=${h16(state.spec.cpu.pc)}`;
}
