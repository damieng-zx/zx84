/**
 * Singleton state for the MCP server.
 *
 * `state.spec`/`state.model`/`state.romData` are populated by `initMachine()`
 * — call (and await) it before touching the singletons.
 *
 * Concrete-machine narrowing lives in `./concrete.ts` (the single sanctioned
 * module); everything here is machine-blind.
 */

import type { Machine } from '../src/machines/machine.ts';
import { entryForModel } from '../src/machines/registry.ts';
import type { MachineModel } from '../src/models.ts';
import { SymbolTable } from '../src/debug/symbols.ts';
import { fetchROM, fetchBootCartridge } from './rom-fetch.ts';
import { wireFdcLog } from './fdc-log.ts';
import { installTrapHook } from './traps.ts';
import { hex16 as h16 } from '../src/utils/hex.ts';

interface State {
  model: MachineModel;
  spec: Machine;
  romData: Uint8Array;
  zx8x16kRam: boolean;
}

// Populated by initMachine(); consumers must await initMachine before access.
export const state = {} as State;

export const symbols = new SymbolTable();

export interface InitMachineOptions {
  /** ZX80/ZX81 RAM pack. Ignored by other machine families. */
  zx8x16kRam?: boolean;
}

export async function initMachine(m: MachineModel, options: InitMachineOptions = {}): Promise<string> {
  state.model = m;
  state.zx8x16kRam = m === 'zx80' || m === 'zx81' ? (options.zx8x16kRam ?? false) : false;
  state.romData = await fetchROM(m);
  // Machines with no on-board ROM (CPC Plus / GX4000) have empty romSources and
  // boot from a hidden default cartridge instead; fetch it via the generic
  // entry hook and install it as the boot image (loadROM routes a .CPR through
  // memory.loadCartridge). Mirrors the shell's applyBootCartridge.
  if (state.romData.length === 0) {
    const cartSource = entryForModel(m).bootCartridgeSource?.(m);
    if (cartSource) state.romData = await fetchBootCartridge(cartSource);
  }
  const machine = entryForModel(m).create(m, null);
  if (machine.kind === 'spectrum') {
    // Spectrum-only headless knob (cheap scanline rendering off-screen).
    (machine as unknown as { scanlineAccuracy: string }).scanlineAccuracy = 'low';
  }
  if (machine.kind === 'zx8x') {
    machine.applySettings({
      get<T>(key: string, fallback: T): T {
        return key === 'zx8x-16k-ram' ? (state.zx8x16kRam as T) : fallback;
      },
    });
  }
  machine.services.roms.installSystemRom(state.romData);
  machine.reset();
  state.spec = machine;
  wireFdcLog(state.spec);
  installTrapHook(state.spec);
  const ram = machine.kind === 'zx8x' ? ` RAM=${state.zx8x16kRam ? '16KB' : '1KB'}` : '';
  return `Machine ready: ${m.toUpperCase()}${ram} PC=${h16(state.spec.services.debug.pc)}`;
}
