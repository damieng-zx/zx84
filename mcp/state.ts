/**
 * Singleton state for the MCP server.
 *
 * `state.spec`/`state.model`/`state.romData` are populated by `initMachine()`
 * — call (and await) it before touching the singletons.
 */

import type { Spectrum } from '../src/machines/spectrum/spectrum.ts';
import type { CpcMachine } from '../src/machines/cpc/cpc-machine.ts';
import type { MsxMachine } from '../src/machines/msx/msx-machine.ts';
import { type Machine, asSpectrum, asCpc, asMsx } from '../src/machines/machine.ts';
import { entryForModel } from '../src/machines/registry.ts';
import type { MachineModel } from '../src/models.ts';
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
/** The active machine as an MsxMachine, or null otherwise. */
export function activeMsx(): MsxMachine | null { return asMsx(state.spec); }

export async function initMachine(m: MachineModel): Promise<string> {
  state.model = m;
  state.romData = await fetchROM(m);
  const machine = entryForModel(m).create(m, null);
  const spec = asSpectrum(machine);
  if (spec) spec.scanlineAccuracy = 'low'; // Spectrum-only headless knob
  machine.loadROM(state.romData);
  machine.reset();
  state.spec = machine;
  wireFdcLog(state.spec);
  installTrapHook(state.spec);
  return `Machine ready: ${m.toUpperCase()} PC=${h16(state.spec.cpu.pc)}`;
}
