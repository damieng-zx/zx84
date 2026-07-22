/**
 * MCP media tools on a machine with no uPD765A and no drives.
 *
 * The disk-inspection tools (weak / disk_geometry / track_geometry /
 * sector_read) and `eject` used to dereference activeFdc()! unchecked: on a
 * machine without a uPD765A (ZX80 here) they threw a TypeError instead of
 * answering. They must decline with a readable message.
 */

import { describe, it, expect } from 'vitest';
import { state } from '../../mcp/state.ts';
import { register } from '../../mcp/tools/media.ts';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';

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

describe('MCP media tools on a machine with no uPD765A fitted', () => {
  const handlers = capture();

  it('disk-inspection tools report instead of throwing', async () => {
    state.model = 'zx80';
    state.spec = new Zx8xMachine('zx80', null);

    const calls: [string, Record<string, unknown>][] = [
      ['disk_geometry', { drive: 0 }],
      ['track_geometry', { track: 0, side: 0, drive: 0 }],
      ['sector_read', { track: 0, sector: 1, side: 0, drive: 0, offset: 0 }],
      ['weak', { track: 0 }],
    ];
    for (const [tool, args] of calls) {
      const handler = handlers.get(tool);
      expect(handler, `${tool} not registered`).toBeDefined();
      const r = await handler!(args);
      expect(r.content[0].text, tool).toMatch(/No uPD765A fitted on ZX80/);
    }
  });

  it('eject disk reports the missing drive instead of throwing', async () => {
    state.model = 'zx80';
    state.spec = new Zx8xMachine('zx80', null);
    const r = await handlers.get('eject')!({ target: 'disk', drive: '0' });
    expect(r.content[0].text).toMatch(/ZX80 has no drive A:/);
  });

  it('eject tape reports the missing deck instead of throwing', async () => {
    state.model = 'zx80';
    state.spec = new Zx8xMachine('zx80', null);
    const r = await handlers.get('eject')!({ target: 'tape', drive: '0' });
    expect(r.content[0].text).toMatch(/ZX80 has no cassette deck/);
  });
});
