/**
 * MCP trace gating — only the Spectrum implements startTrace today (every
 * other machine's is a no-op stub), so `trace` must refuse up front rather
 * than claim "Trace started" while nothing is captured, matching the guard
 * stop_trace always had.
 */

import { describe, it, expect } from 'vitest';
import { state } from '../../mcp/state.ts';
import { register } from '../../mcp/tools/trace.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

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

describe('MCP trace tools on a machine with no trace engine', () => {
  it('trace refuses to start on a CPC instead of lying', async () => {
    state.model = 'cpc6128';
    state.spec = new CpcMachine('cpc6128', null);
    const handlers = capture();

    const r = await handlers.get('trace')!({ mode: 'full' });
    expect(r.content[0].text).toMatch(/Spectrum-only \(active model: CPC6128\)/);

    const stop = await handlers.get('stop_trace')!({});
    expect(stop.content[0].text).toMatch(/Spectrum-only \(active model: CPC6128\)/);

    const frame = await handlers.get('frame_trace')!({});
    expect(frame.content[0].text).toMatch(/Spectrum-only \(active model: CPC6128\)/);
  });
});
