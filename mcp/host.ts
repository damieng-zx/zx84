/**
 * The MCP server's MachineHost — the operator's-panel callbacks a machine may
 * invoke (SPI `attachHost`). Machines must function with no host attached, but
 * attaching one enables the flows that call back out: a snapshot taken on a
 * different model asks for a rebuild (host.requestModel), which the MCP honours
 * by re-running initMachine and reporting the mount for a replay.
 */

import type { MachineHost } from '../src/machines/machine.ts';
import type { MachineModel } from '../src/models.ts';
import { initMachine } from './state.ts';

export function createMcpHost(): MachineHost {
  return {
    // Headless: status lines come back as tool results; nothing is pushed.
    setStatus: () => {},
    // Always grant a rebuild — the MCP has no user to decline for. initMachine
    // swaps state.spec to the fresh machine (and destroys the old one); the
    // service that asked then reports needsReplay and the caller re-dispatches.
    requestModel: async (model: MachineModel, _reason: string) => {
      await initMachine(model);
      return true;
    },
    // No media persistence headless — the session is the lifetime.
    persistMedia: () => {},
  };
}
