/**
 * Reading the Atari's memory for inspection (AtariMemory.peekByte): the same
 * bytes the CPU would see, but without what a real read does to the hardware.
 * A read of the PIA's data register clears its interrupt flags and a read of
 * the cartridge control area switches a bank, so a debugger dumping $D000-$D5FF
 * through the CPU's path would change the machine it is looking at.
 */

import { describe, it, expect } from 'vitest';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { ATARI_OS_SIZE } from '@/machines/atari/models.ts';
import { state } from '../../mcp/state.ts';
import { register as registerMemory } from '../../mcp/tools/memory.ts';

function boot(): AtariMachine {
  const m = new AtariMachine('atari800', null, 'pal');
  m.services.roms.installSystemRom(new Uint8Array(ATARI_OS_SIZE));
  m.reset();
  return m;
}

/** Port A's data register selected, with its C1 interrupt flag set. */
function setPiaFlag(m: AtariMachine): void {
  m.pia.cr[0] = 0x04;
  const s = m.pia.exportState();
  s[4] = 0x04;   // cr[0]
  s[6] = 1;      // C1 flag, port A
  m.pia.importState(s);
}

const c1Flag = (m: AtariMachine): number => m.pia.exportState()[6];

describe('Atari peekByte', () => {
  it('reads the PIA data register without clearing its interrupt flags; a real read does', () => {
    const m = boot();
    try {
      setPiaFlag(m);
      expect(c1Flag(m)).toBe(1);
      const peeked = m.memory.peekByte(0xD300);
      expect(c1Flag(m)).toBe(1);
      // It is the value a read returns.
      expect(m.memory.readByte(0xD300)).toBe(peeked);
      expect(c1Flag(m)).toBe(0);
    } finally { m.destroy(); }
  });

  it('shows the control register with its flag bit, and the DDR while the DDR is selected', () => {
    const m = boot();
    try {
      setPiaFlag(m);
      expect(m.memory.peekByte(0xD302) & 0x84).toBe(0x84);   // flag set, data register selected
      m.pia.cr[0] = 0x00;
      m.pia.ddr[0] = 0xF0;
      expect(m.memory.peekByte(0xD300)).toBe(0xF0);
    } finally { m.destroy(); }
  });

  it('does not switch a cartridge bank by reading the control area; a real read does', () => {
    const m = boot();
    try {
      const oss = new Uint8Array(0x4000);
      oss[0x1fff] = 0; oss[0x2fff] = 9; oss[0x3fff] = 1;
      oss[0x0000] = 0x11; oss[0x1000] = 0x22; oss[0x2000] = 0x33; oss[0x3000] = 0x44;
      m.services.roms.cartridge.insert(oss, 'oss.rom');
      const before = m.memory.peekByte(0xA000);
      m.memory.peekByte(0xD509);                              // would select the bank at $2000
      expect(m.memory.peekByte(0xA000)).toBe(before);
      m.memory.readByte(0xD509);
      expect(m.memory.peekByte(0xA000)).toBe(0x33);
    } finally { m.destroy(); }
  });

  it('agrees with a real read for the registers that read without side effects', () => {
    const m = boot();
    try {
      m.tick();
      for (const addr of [0xD010, 0xD014, 0xD01F, 0xD20A, 0xD20E, 0xD20F, 0xD40B, 0xD40F, 0xD100, 0xD600 - 1]) {
        expect(m.memory.peekByte(addr)).toBe(m.memory.readByte(addr));
      }
    } finally { m.destroy(); }
  });

  it('reads plain memory and ROM exactly as readByte does, and a block of it', () => {
    const m = boot();
    try {
      m.memory.writeByte(0x1234, 0x5A);
      expect(m.memory.peekByte(0x1234)).toBe(0x5A);
      const block = m.memory.readBlock(0x1234, 3);
      expect(Array.from(block)).toEqual([0x5A, m.memory.peekByte(0x1235), m.memory.peekByte(0x1236)]);
    } finally { m.destroy(); }
  });

  it('readBlock over the hardware window leaves the flags alone too', () => {
    const m = boot();
    try {
      setPiaFlag(m);
      m.memory.readBlock(0xD300, 4);
      expect(c1Flag(m)).toBe(1);
    } finally { m.destroy(); }
  });
});

describe('MCP read_memory on the Atari', () => {
  it('dumps the hardware window without disturbing it', async () => {
    const m = boot();
    try {
      state.model = 'atari800';
      state.spec = m;
      const handlers = new Map<string, (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>>();
      registerMemory({ registerTool: (name: string, _s: unknown, h: never) => { handlers.set(name, h); } } as never);
      setPiaFlag(m);
      const out = (await handlers.get('read_memory')!({ address: 'D300', length: 16 })).content[0].text;
      expect(out).toMatch(/^D300 /);
      expect(c1Flag(m)).toBe(1);
      // find reads the same way.
      await handlers.get('find')!({ hex_bytes: 'AA' });
      expect(c1Flag(m)).toBe(1);
    } finally { m.destroy(); }
  });
});
