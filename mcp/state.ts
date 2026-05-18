/**
 * Singleton state for the MCP server.
 *
 * `state.spec`/`state.model`/`state.romData` are populated by `initMachine()`
 * — call (and await) it before touching the singletons.
 */

import { Spectrum, type SpectrumModel } from '../src/spectrum.ts';
import { SymbolTable } from '../src/debug/symbols.ts';
import { fetchROM } from './rom-fetch.ts';
import { wireFdcLog } from './fdc-log.ts';
import { installTrapHook } from './traps.ts';
import { h16 } from './hex.ts';

interface State {
  model: SpectrumModel;
  spec: Spectrum;
  romData: Uint8Array;
}

// Populated by initMachine(); consumers must await initMachine before access.
export const state = {} as State;

export const symbols = new SymbolTable();

export async function initMachine(m: SpectrumModel): Promise<string> {
  state.model = m;
  state.romData = await fetchROM(m);
  state.spec = new Spectrum(m);
  state.spec.scanlineAccuracy = 'low';
  state.spec.loadROM(state.romData);
  state.spec.reset();
  wireFdcLog(state.spec);
  installTrapHook(state.spec);
  return `Machine ready: ${m.toUpperCase()} PC=${h16(state.spec.cpu.pc)}`;
}
