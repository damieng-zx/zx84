/**
 * Cross-model mount replay — a snapshot for a different model asks the host
 * to rebuild (host.requestModel) and the mount reports `replay`; the MCP must
 * re-dispatch the same bytes to the replacement machine, exactly like the
 * shell's reflectMount. Pre-fix the replay flag was ignored and the media
 * silently never loaded (the service's message is empty by design).
 */

import { describe, it, expect } from 'vitest';
import { state } from '../../mcp/state.ts';
import { mountMediaBytes } from '../../mcp/loader.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import type { MachineHost } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';

/** A `.SNA` header (256 bytes) for a given CPC model — enough for
 *  readCpcSnaModel to identify it (signature + version + type byte). */
function snaHeader(type: 0 | 1 | 2, version = 2): Uint8Array {
  const d = new Uint8Array(256);
  d.set([0x4d, 0x56, 0x20, 0x2d, 0x20, 0x53, 0x4e, 0x41], 0);   // "MV - SNA"
  d[0x10] = version;
  d[0x6d] = type;   // 0=464, 1=664, 2=6128
  return d;
}

describe('MCP cross-model mount replay', () => {
  it('re-dispatches a snapshot to the rebuilt machine', async () => {
    const original = new CpcMachine('cpc6128', null);
    state.model = 'cpc6128';
    state.spec = original;

    // A host that honours requestModel the way the MCP host does: swap the
    // active machine for the requested model and grant the request.
    const host: MachineHost = {
      setStatus: () => {},
      requestModel: async (model: MachineModel) => {
        state.model = model;
        state.spec = new CpcMachine(model as 'cpc464', null);
        return true;
      },
      persistMedia: () => {},
    };
    original.attachHost(host);

    // A 464 snapshot mounted on the running 6128.
    const result = await mountMediaBytes(original, snaHeader(0), 'game.sna');

    // The mount was re-dispatched: the active machine is the 464 rebuild,
    // and the user got a real answer rather than the empty replay message.
    expect(state.spec).not.toBe(original);
    expect(state.model).toBe('cpc464');
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toMatch(/needs a matching CPC model/);
  });
});
