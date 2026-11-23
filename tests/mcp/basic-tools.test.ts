/**
 * The `basic_listing` and `basic_vars` MCP tools, driven through their
 * registered handlers against a real Spectrum.
 *
 * The program bytes follow the Spectrum ROM's own line-record layout, which is
 * what the ROM's LIST walks: a big-endian line number, a little-endian length
 * (body + the 0x0D terminator), the detokenised body, then 0x0D. The program
 * ends at the 0x80 terminator, and PROG/VARS in the system variables bracket
 * it. Expectations are the tool's documented output shape — `<line> <text>`,
 * one per line — not whatever a shared helper happens to produce.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../../mcp/state.ts';
import { register as registerBasic } from '../../mcp/tools/basic.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';

type Result = { content: { type: 'text'; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function capture(...registers: Array<(s: never) => void>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, handler: Handler) => { handlers.set(name, handler); },
  };
  for (const r of registers) r(fakeServer as never);
  return handlers;
}

const tools = capture(registerBasic);
const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> =>
  (await tools.get(name)!(args)).content[0].text;

const PROG = 0x8000;

/** Tokenised PRINT, and PRINT "HI" (inline ASCII inside the quotes). */
const PRINT = 0xF5;

/**
 * Lay a tokenised program into the machine's RAM at PROG, with PROG/VARS in the
 * system variables pointing at it — the state the ROM leaves after entering
 * those lines at the keyboard.
 */
function writeProgram(s: Spectrum, lines: Array<{ no: number; body: number[] }>): void {
  const mem = s.memory;
  let addr = PROG;
  for (const line of lines) {
    const lineLen = line.body.length + 1; // body + 0x0D
    mem.writeByte(addr, (line.no >> 8) & 0xFF);
    mem.writeByte(addr + 1, line.no & 0xFF);
    mem.writeByte(addr + 2, lineLen & 0xFF);
    mem.writeByte(addr + 3, (lineLen >> 8) & 0xFF);
    for (let i = 0; i < line.body.length; i++) mem.writeByte(addr + 4 + i, line.body[i]);
    mem.writeByte(addr + 4 + line.body.length, 0x0D);
    addr += 4 + lineLen;
  }
  mem.writeByte(addr, 0x80); // end-of-program marker
  mem.writeByte(0x5C53, PROG & 0xFF); mem.writeByte(0x5C54, PROG >> 8);
  mem.writeByte(0x5C4B, addr & 0xFF); mem.writeByte(0x5C4C, (addr >> 8) & 0xFF);
}

describe('basic_listing / basic_vars MCP tools', () => {
  beforeEach(() => {
    state.spec = new Spectrum('zx48k', null);
    state.model = 'zx48k';
  });

  it('lists a tokenised program one line per record', async () => {
    writeProgram(state.spec as Spectrum, [
      { no: 10, body: [PRINT, 0x22, 0x48, 0x49, 0x22] }, // PRINT "HI"
      { no: 20, body: [PRINT, 0x31] },                   // PRINT 1
    ]);
    const out = await call('basic_listing');
    const rows = out.split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe('10 PRINT "HI"');
    expect(rows[1]).toBe('20 PRINT 1');
  });

  it('selects one line or an inclusive range', async () => {
    writeProgram(state.spec as Spectrum, [
      { no: 10, body: [PRINT, 0x31] },
      { no: 20, body: [PRINT, 0x32] },
      { no: 30, body: [PRINT, 0x33] },
    ]);
    expect(await call('basic_listing', { line: '20' })).toBe('20 PRINT 2');
    expect(await call('basic_listing', { line: '20-30' })).toBe('20 PRINT 2\n30 PRINT 3');
  });

  it('explains a line filter that matches nothing, naming the real extent', async () => {
    writeProgram(state.spec as Spectrum, [
      { no: 10, body: [PRINT, 0x31] },
      { no: 30, body: [PRINT, 0x33] },
    ]);
    const out = await call('basic_listing', { line: '15' });
    expect(out).toContain('No program lines in line 15');
    expect(out).toContain('10-30');
  });

  it('rejects a malformed line filter', async () => {
    writeProgram(state.spec as Spectrum, [{ no: 10, body: [PRINT, 0x31] }]);
    expect(await call('basic_listing', { line: 'nonsense' })).toContain('Invalid line');
    expect(await call('basic_listing', { line: '30-10' })).toContain('Invalid line');
  });

  it('says an empty program is empty rather than returning nothing', async () => {
    // PROG == VARS, as the ROM leaves it with no program entered.
    state.spec.memory.writeByte(PROG, 0x80);
    state.spec.memory.writeByte(0x5C53, PROG & 0xFF); state.spec.memory.writeByte(0x5C54, PROG >> 8);
    state.spec.memory.writeByte(0x5C4B, PROG & 0xFF); state.spec.memory.writeByte(0x5C4C, PROG >> 8);
    expect(await call('basic_listing')).toBe('No BASIC program in memory.');
  });

  it('reports no variables on a fresh machine', async () => {
    state.spec.memory.writeByte(0x5C4B, PROG & 0xFF); state.spec.memory.writeByte(0x5C4C, PROG >> 8);
    state.spec.memory.writeByte(0x5C59, PROG & 0xFF); state.spec.memory.writeByte(0x5C5A, PROG >> 8);
    expect(await call('basic_vars')).toBe('No BASIC variables defined.');
  });

  it('lists simple variables and filters by name', async () => {
    // The Spectrum's variables area: one record per variable, the first byte
    // carrying the letter and its type (0x60|letter = numeric, 0x40|letter =
    // string), then the value. `a` holds 1 (integer form: 2-byte small int in
    // bytes 2-3, not the big-endian integer in bytes 1-2), `b$` holds "HI".
    const mem = state.spec.memory;
    mem.writeByte(PROG, 0x60 | 0x01);                       // 'a'
    mem.writeByte(PROG + 1, 0x00); mem.writeByte(PROG + 2, 0x00);
    mem.writeByte(PROG + 3, 0x01); mem.writeByte(PROG + 4, 0x00); mem.writeByte(PROG + 5, 0x00);
    mem.writeByte(PROG + 6, 0x40 | 0x02);                   // 'b$'
    mem.writeByte(PROG + 7, 0x02); mem.writeByte(PROG + 8, 0x00);
    mem.writeByte(PROG + 9, 0x48); mem.writeByte(PROG + 10, 0x49);
    mem.writeByte(PROG + 11, 0x80);
    mem.writeByte(0x5C4B, PROG & 0xFF); mem.writeByte(0x5C4C, PROG >> 8);
    mem.writeByte(0x5C59, (PROG + 11) & 0xFF); mem.writeByte(0x5C5A, (PROG + 11) >> 8);

    const all = await call('basic_vars');
    expect(all).toContain('2 variable(s):');
    expect(all).toContain('a = 1');
    // String variables are stored with an upper-case letter byte (0x41-0x5A),
    // which is how the ROM keeps them, so the listing shows B$.
    expect(all).toContain('B$ = HI');

    // Filtering is case-insensitive, as the machine prints names in its own case.
    expect(await call('basic_vars', { name: 'B$' })).toBe('B$ = HI');
    expect(await call('basic_vars', { name: 'b$' })).toBe('B$ = HI');
    expect(await call('basic_vars', { name: 'zz' })).toContain('No variable named "zz"');
    expect(await call('basic_vars', { name: 'zz' })).toContain('a, B$');
  });

  it('declines cleanly on a machine with no BASIC parser', async () => {
    state.model = 'apple1' as never;
    state.spec = { services: {} } as never;
    expect(await call('basic_listing')).toContain('has no BASIC listing parser');
    expect(await call('basic_vars')).toContain('has no BASIC variables parser');
  });

  it('declines on a real machine that has no BASIC parser (Apple II)', async () => {
    // Not a stub: the Apple II genuinely ships no `inspect` service, so the
    // tool must name the machine and say it has none rather than report an
    // empty program.
    const apple2 = new Apple2Machine('apple2e', null);
    state.spec = apple2 as never;
    state.model = 'apple2e' as never;
    expect(apple2.services.inspect).toBeUndefined();
    expect(await call('basic_listing')).toBe('The active machine (APPLE2E) has no BASIC listing parser.');
  });
});
