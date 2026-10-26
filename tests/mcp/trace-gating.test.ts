/**
 * MCP trace tools on machines other than the Spectrum: `trace` starts the
 * machine's own trace engine in the modes its descriptor offers and refuses
 * the rest up front (a 6502 machine has no ZXTL layout), `stop_trace` returns
 * whatever the engine captured, and `frame_trace` — which wraps the Spectrum's
 * contention hooks — stays Spectrum-only.
 */

import { describe, it, expect } from 'vitest';
import { state } from '../../mcp/state.ts';
import { register } from '../../mcp/tools/trace.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';

type Result = { content: { type: 'text'; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function capture(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, handler: Handler) => { handlers.set(name, handler); },
  };
  register(fakeServer as never);
  return handlers;
}

describe('MCP trace tools on a Z80 machine (CPC)', () => {
  it('traces port I/O and returns the summary', async () => {
    state.model = 'cpc6128';
    state.spec = new CpcMachine('cpc6128', null);
    const handlers = capture();

    expect((await handlers.get('stop_trace')!({})).content[0].text).toBe('Not tracing');
    const r = await handlers.get('trace')!({ mode: 'portio' });
    expect(r.content[0].text).toBe('Trace started (portio mode)');
    state.spec.tick();
    const stop = await handlers.get('stop_trace')!({});
    expect(stop.content[0].text).toMatch(/^=== Port IO Summary ===/);
    expect((await handlers.get('stop_trace')!({})).content[0].text).toBe('Not tracing');
  });

  it('keeps a ZXTL trace in memory for trace_read', async () => {
    state.model = 'cpc6128';
    state.spec = new CpcMachine('cpc6128', null);
    const handlers = capture();

    await handlers.get('trace')!({ mode: 'zxtl' });
    state.spec.tick();
    const stop = await handlers.get('stop_trace')!({});
    expect(stop.content[0].text).toMatch(/^ZXTL trace stopped: \d+ lines stored in memory/);
    const read = await handlers.get('trace_read')!({ from: 0, to: 1 });
    expect(read.content[0].text).toMatch(/ZXTL V0001/);
  });

  it('frame_trace stays Spectrum-only', async () => {
    state.model = 'cpc6128';
    state.spec = new CpcMachine('cpc6128', null);
    const frame = await capture().get('frame_trace')!({});
    expect(frame.content[0].text).toMatch(/Spectrum-only \(active model: CPC6128\)/);
  });
});

describe('MCP trace tools on a 6502 machine (BBC Micro)', () => {
  it('refuses the Z80-only ZXTL mode instead of claiming a trace started', async () => {
    state.model = 'bbc-b';
    state.spec = new BbcMachine('bbc-b', null);
    const handlers = capture();

    const r = await handlers.get('trace')!({ mode: 'zxtl' });
    expect(r.content[0].text).toBe('Trace mode "zxtl" is not available on BBC-B (modes: full, portio).');
    expect(state.spec.services.debug.traceSession()).toBeNull();
    expect((await handlers.get('stop_trace')!({})).content[0].text).toBe('Not tracing');
  });

  it('traces memory-mapped I/O in portio mode', async () => {
    state.model = 'bbc-b';
    state.spec = new BbcMachine('bbc-b', null);
    const handlers = capture();

    expect((await handlers.get('trace')!({ mode: 'portio' })).content[0].text).toBe('Trace started (portio mode)');
    state.spec.tick();
    expect((await handlers.get('stop_trace')!({})).content[0].text).toMatch(/^=== I\/O Access Summary ===/);
  });
});
