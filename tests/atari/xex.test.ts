/**
 * Atari executable (XEX) loading tests.
 *
 * Expectations follow DOS 2 binary load: $FF $FF then segments of start, end
 * (inclusive), data, with the marker allowed again before later segments;
 * INITAD ($02E2) is cleared before each segment and called once it has
 * loaded; RUNAD ($02E0) is where the program starts, defaulting here to the
 * first segment's start when the file sets none.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { XEX_TRAP, XexLoader, parseXex, xexBootSector, type XexHost } from '@/machines/atari/xex.ts';

function seg(start: number, bytes: number[], marker = false): number[] {
  const end = start + bytes.length - 1;
  return [...(marker ? [0xff, 0xff] : []), start & 0xff, start >> 8, end & 0xff, end >> 8, ...bytes];
}
function xex(...segments: number[][]): Uint8Array {
  return new Uint8Array([0xff, 0xff, ...segments.flat()]);
}

describe('atari XEX parser', () => {
  it('reads segments with and without a repeated $FFFF marker', () => {
    const s = parseXex(xex(seg(0x2000, [1, 2, 3]), seg(0x3000, [4], true), seg(0x02e0, [0x00, 0x20])))!;
    expect(s.map(x => [x.start, x.end, [...x.data]])).toEqual([
      [0x2000, 0x2002, [1, 2, 3]], [0x3000, 0x3000, [4]], [0x02e0, 0x02e1, [0x00, 0x20]],
    ]);
  });

  it('rejects a file without the $FFFF header', () => {
    expect(parseXex(new Uint8Array([0x00, 0x20, 0x00, 0x20, 0xea, 0, 0]))).toBeNull();
  });

  it('keeps what a truncated last segment holds, and stops at an inverted range', () => {
    const truncated = new Uint8Array([0xff, 0xff, 0x00, 0x20, 0x09, 0x20, 1, 2, 3]);
    expect(parseXex(truncated)!.map(x => [x.start, x.end])).toEqual([[0x2000, 0x2002]]);
    const inverted = xex(seg(0x2000, [1]), [0x00, 0x30, 0x00, 0x20]);
    expect(parseXex(inverted)).toHaveLength(1);
  });
});

/** A fake 64K bus recording the loader's calls. */
function fakeHost() {
  const mem = new Uint8Array(0x10000);
  const calls: string[] = [];
  const host: XexHost = {
    read: (a) => mem[a],
    write: (a, v) => { mem[a] = v; },
    pushReturn: (a) => calls.push(`push ${a.toString(16)}`),
    jump: (a) => calls.push(`jump ${a.toString(16)}`),
  };
  return { mem, calls, host };
}

describe('atari XEX loader', () => {
  it('calls INITAD after the segment that sets it, then runs at RUNAD', () => {
    const segments = parseXex(xex(
      seg(0x2000, [0xaa]),
      seg(0x02e2, [0x00, 0x21]),        // INITAD = $2100
      seg(0x3000, [0xbb]),
      seg(0x02e0, [0x00, 0x30]),        // RUNAD = $3000
    ))!;
    const loader = new XexLoader('t.xex', segments);
    const { mem, calls, host } = fakeHost();
    mem[0x02e2] = 0x99; // stale INITAD must not fire for the first segment
    loader.trap(host);
    expect(mem[0x2000]).toBe(0xaa);
    expect(calls).toEqual([`push ${XEX_TRAP.toString(16)}`, 'jump 2100']);
    expect(mem[0x3000]).toBe(0); // not loaded until init returns
    calls.length = 0;
    loader.trap(host); // the init routine's RTS lands on the trap
    expect(mem[0x3000]).toBe(0xbb);
    expect(calls).toEqual([`push ${XEX_TRAP.toString(16)}`, 'jump 3000']);
    expect(loader.phase).toBe('running');
  });

  it('runs at the first segment when the file sets no RUNAD', () => {
    const loader = new XexLoader('t.xex', parseXex(xex(seg(0x4000, [0xea])))!);
    const { calls, host, mem } = fakeHost();
    mem[0x02e0] = 0x12; // a stale RUNAD is cleared when loading starts
    mem[0x02e1] = 0x34;
    loader.trap(host);
    expect(calls.at(-1)).toBe('jump 4000');
  });

  it('goes to DOSVEC if the program returns', () => {
    const loader = new XexLoader('t.xex', parseXex(xex(seg(0x4000, [0x60])))!);
    const { calls, host, mem } = fakeHost();
    loader.trap(host);
    mem[0x0a] = 0x34;
    mem[0x0b] = 0x12;
    loader.trap(host);
    expect(calls.at(-1)).toBe('jump 1234');
  });

  it('boots through a one-sector record that jumps to the trap', () => {
    const s = xexBootSector();
    expect([...s.subarray(0, 6)]).toEqual([0x00, 0x01, 0x00, 0x07, 0x09, 0x07]);
    expect([...s.subarray(6, 9)]).toEqual([0x4c, XEX_TRAP & 0xff, XEX_TRAP >> 8]);
    expect(s[9]).toBe(0x60); // DOSINI's RTS
  });
});

describe('atari XEX mounting', () => {
  const file = xex(seg(0x3000, [0xea]));

  it('pulls a cartridge so it cannot cover $A000 or take the boot', async () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.services.roms.cartridge!.insert(new Uint8Array(0x2000), 'basic.rom');
      await m.services.media.mount(file, 'game.xex');
      expect(m.memory.cart).toBeNull();
      expect(m.xex?.phase).toBe('boot');
    } finally {
      m.destroy();
    }
  });

  it('holds OPTION through an XL boot so built-in BASIC stays out', async () => {
    const m = new AtariMachine('atari800xl', null);
    try {
      await m.services.media.mount(file, 'game.xex');
      expect(m.gtia.readReg(0xd01f) & 0x04).toBe(0); // OPTION held
    } finally {
      m.destroy();
    }
  });

  it('answers D1: with the boot record while the file waits', async () => {
    const m = new AtariMachine('atari800', null);
    try {
      await m.services.media.mount(file, 'game.xex');
      const w = (a: number, v: number) => m.memory.writeByte(a, v);
      [0x31, 1, 0x52, 0, 0x00, 0x04, 0, 0, 128, 0, 1, 0].forEach((v, i) => w(0x0300 + i, v));
      m.cpu.sp = 0xfd;
      m.memory.writeByte(0x01fe, 0xff);
      m.memory.writeByte(0x01ff, 0x11);
      m.sio.handle();
      expect(m.memory.readByte(0x0303)).toBe(0x01);
      expect(m.memory.readByte(0x0406)).toBe(0x4c); // JMP XEX_TRAP
    } finally {
      m.destroy();
    }
  });

  it('lets a boot disk in D1: replace an armed executable', async () => {
    const m = new AtariMachine('atari800', null);
    try {
      await m.services.media.mount(file, 'game.xex');
      await m.services.media.mount(new Uint8Array(720 * 128), 'boot.xfd', 'a');
      expect(m.xex).toBeNull();
    } finally {
      m.destroy();
    }
  });
});

const DIR = process.env.ATARI_ROM_DIR ?? resolve(__dirname, '../../mcp/.cache');
const OSB = resolve(DIR, 'atariosb.rom');
const XL = [resolve(DIR, 'atari800xl.rom'), resolve(DIR, 'REV02.ROM')].find(existsSync);
const BASIC = resolve(DIR, 'ataribas.rom');

describe.skipIf(!existsSync(OSB) || !XL || !existsSync(BASIC))('atari XEX boot with the real OS', { timeout: 30_000 }, () => {
  // An init segment that stores $11 at $0600, then a program at $3000 that
  // loops storing $46 into COLOR4; RUNAD = $3000.
  const program = xex(
    seg(0x2f00, [0xa9, 0x11, 0x8d, 0x00, 0x06, 0x60]),
    seg(0x02e2, [0x00, 0x2f]),
    seg(0x3000, [0xa9, 0x46, 0x8d, 0xc8, 0x02, 0x4c, 0x00, 0x30]),
    seg(0x02e0, [0x00, 0x30]),
  );

  it.each(['atari800', 'atari800xl'] as const)('boots and runs on the %s', async (model) => {
    const m = new AtariMachine(model, null);
    try {
      const os = new Uint8Array(readFileSync(model === 'atari800' ? OSB : XL!));
      const basic = new Uint8Array(readFileSync(BASIC));
      m.services.roms.installSystemRom(model === 'atari800' ? os : new Uint8Array([...os, ...basic]));
      if (model === 'atari800') m.services.roms.cartridge!.insert(basic, '');
      m.setSpeedMultiplier(0);
      await m.services.media.mount(program, 'test.xex');
      for (let f = 0; f < 400 && m.memory.readByte(0x02c8) !== 0x46; f++) m.tick();
      expect(m.memory.readByte(0x0600)).toBe(0x11); // INITAD ran
      expect(m.memory.readByte(0x02c8)).toBe(0x46); // RUNAD ran
      expect(m.xex?.phase).toBe('running');
      expect(m.gtia.readReg(0xd01f) & 0x04).toBe(0x04); // OPTION let go
      if (model === 'atari800xl') expect(m.memory.basicRomEnabled).toBe(false);
    } finally {
      m.destroy();
    }
  });
});
