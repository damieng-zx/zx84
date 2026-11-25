/**
 * The MCP input tools against a real Apple ][+ keyboard.
 *
 * The tools used to press a modifier as a separate key event and send the next
 * key with no modifier flags. The Apple II's encoder takes SHIFT and CTRL from
 * the event that carries the character, so `shift+2` arrived as plain `2`, and
 * `type "` sent the Spectrum's SYM+P chord (a `P`). Both are driven here through
 * the production registrations, reading the keyboard latch at $C000.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { state } from '../../mcp/state.ts';
import { register as registerIo } from '../../mcp/tools/io.ts';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';

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

const tools = capture(registerIo);
const typeText = async (text: string): Promise<string> =>
  (await tools.get('type')!({ text })).content[0].text;
const pressKey = async (name: string): Promise<string> =>
  (await tools.get('key')!({ name })).content[0].text;

/** A ][+ whose 12K ROM loops, so frames can run without touching the latch. */
function bootPlus(): Apple2Machine {
  const rom = new Uint8Array(0x3000);
  rom.set([0x4C, 0x00, 0xD0], 0);
  rom[0x2FFC] = 0x00;
  rom[0x2FFD] = 0xD0;
  const m = new Apple2Machine('apple2-plus', null);
  m.loadROM(rom);
  m.reset();
  for (let i = 0; i < 5; i++) m.tick();
  return m;
}

describe('MCP input on the Apple ][+', () => {
  beforeEach(() => {
    state.spec = bootPlus();
    state.model = 'apple2-plus';
  });
  afterEach(() => state.spec.destroy());

  it('types the character asked for, not a Spectrum symbol chord', async () => {
    await typeText('"');
    expect(state.spec.memory.readByte(0xC000)).toBe(0x80 | 0x22);   // "
  });

  it('types the upper-case letter the ][ encoder can produce', async () => {
    await typeText('a');
    expect(state.spec.memory.readByte(0xC000)).toBe(0x80 | 0x41);   // A
  });

  it('carries SHIFT into the key event of a combo', async () => {
    await pressKey('shift+2');
    // The host-key mapping follows the PC's shift pairs: SHIFT-2 is '@'.
    expect(state.spec.memory.readByte(0xC000)).toBe(0x80 | 0x40);
  });

  it('carries CTRL into the key event of a combo', async () => {
    await pressKey('ctrl+a');
    expect(state.spec.memory.readByte(0xC000)).toBe(0x80 | 0x01);
  });
});
