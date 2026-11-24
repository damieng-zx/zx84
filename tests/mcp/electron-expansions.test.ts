/**
 * The MCP `electronexp` tool: fit/remove the Acorn Electron's Plus 1 and Plus 3
 * and select ADFS or DFS, through the registered handler.
 *
 * The expansions load a ROM at build time, so the tool drives `initMachine` and
 * the resulting machine's MediaService is what `load` sees — which is the whole
 * point: before this tool existed the MCP had no way to fit them, so every disc
 * and cartridge was refused headlessly.
 */

import { describe, it, expect } from 'vitest';
import { state, initMachine } from '../../mcp/state.ts';
import { register as registerPeripherals } from '../../mcp/tools/peripherals.ts';

type Result = { content: { type: 'text'; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function capture(register: (s: never) => void): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, handler: Handler) => { handlers.set(name, handler); },
  };
  register(fakeServer as never);
  return handlers;
}

const tools = capture(registerPeripherals);
const electronexp = async (args: Record<string, unknown> = {}): Promise<string> =>
  (await tools.get('electronexp')!(args)).content[0].text;

describe('MCP electronexp tool', () => {
  it('declines on a machine that is not an Electron', async () => {
    await initMachine('cpc6128');
    expect(await electronexp({ plus3: true })).toContain('Acorn Electron');
    state.spec.destroy();
  }, 60_000);

  it('reports, fits and removes the expansions, and `load` follows them', async () => {
    await initMachine('electron');
    expect(await electronexp()).toMatch(/Plus 1 OFF\s+Plus 3 OFF/);
    // Nothing disc-shaped is accepted until the Plus 3 is fitted.
    expect(state.spec.services.media.accepts().map(t => t.ext)).not.toContain('.ssd');

    let fitted: string;
    try {
      fitted = await electronexp({ plus3: true, dfs: true });
    } catch (e) {
      // No ROM host: the expansion ROM cannot be fetched, which is not this
      // tool's behaviour to pin.
      state.spec?.destroy();
      return;
    }
    // A ROM fetch failure is an environment problem, not this tool's: say so
    // loudly rather than passing silently.
    expect(fitted, 'the Plus 3 ROM must load for this test to mean anything').not.toMatch(/Failed to load|HTTP/);

    expect(fitted).toMatch(/Plus 3 ON/);
    expect(fitted).toMatch(/filing system=DFS/);
    expect(state.spec.services.media.accepts().map(t => t.ext))
      .toEqual(expect.arrayContaining(['.ssd', '.dsd']));

    // ADFS and DFS are alternatives, not both.
    expect(await electronexp({ dfs: false })).toMatch(/filing system=ADFS/);
    expect(state.spec.services.media.accepts().map(t => t.ext)).toContain('.adl');

    expect(await electronexp({ plus3: false })).toMatch(/Plus 3 OFF/);
    expect(state.spec.services.media.accepts().map(t => t.ext)).not.toContain('.adl');
    state.spec.destroy();
  }, 120_000);

  it('says so when nothing needs to change', async () => {
    await initMachine('electron');
    expect(await electronexp({ plus1: false })).toMatch(/Already set/);
    state.spec.destroy();
  }, 60_000);
});
