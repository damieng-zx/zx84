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
import { applyHeadlessKnobs } from './concrete.ts';
import { createMcpHost } from './host.ts';
import { hex16 as h16 } from '../src/utils/hex.ts';

interface State {
  model: MachineModel;
  spec: Machine;
  romData: Uint8Array;
}

// Populated by initMachine(); consumers must await initMachine before access.
export const state = {} as State;

export const symbols = new SymbolTable();

export interface InitMachineOptions {
  /** ZX80/ZX81 RAM pack. Ignored by other machine families. */
  zx8x16kRam?: boolean;
  /** ZX81 user-defined character RAM mapped at $3000-$3FFF. */
  zx81UdgRam?: boolean;
  /** ZX81 refresh-readable WRX bitmap RAM mapped at $2000-$3FFF. */
  zx81WrxHires?: boolean;
}

export async function initMachine(m: MachineModel, options: InitMachineOptions = {}): Promise<string> {
  // Tear down the machine being replaced (headless this just cancels timers
  // and closes audio/turbo plumbing) — including when a mount triggered this
  // rebuild via host.requestModel, mid-mount on the OLD machine; its service
  // returns needsReplay immediately afterwards and touches nothing more.
  state.spec?.destroy();
  state.model = m;
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
  machine.attachHost(createMcpHost());
  const ramNote = applyHeadlessKnobs(machine, options);
  machine.services.roms.installSystemRom(state.romData);
  machine.reset();
  state.spec = machine;
  wireFdcLog(state.spec);
  installTrapHook(state.spec);
  return `Machine ready: ${m.toUpperCase()}${ramNote} PC=${h16(state.spec.services.debug.pc)}`;
}
