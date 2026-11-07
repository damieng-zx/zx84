/**
 * Jupiter Ace snapshots: zx84's native `.acestate` (exact resume, refusal of
 * damaged files and of a RAM pack the machine does not have) and xAce's
 * `.ace` memory snapshots.
 *
 * The exact-resume checks run on a small synthetic ROM that keeps the video
 * RAM, character RAM, stack, buzzer and IM 1 interrupt all moving, and on the
 * real FORTH ROM when it is to hand (mcp/.cache/ace.rom or ACE_ROM).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JupiterAceMachine } from '@/machines/jupiter-ace/ace-machine.ts';
import { parseAceSnapshot } from '@/machines/jupiter-ace/snapshots/ace-snapshot.ts';
import { expectDamagedRefused, expectExactResume, observe } from '../machines/native-state-harness.ts';

const ROM_PATH = process.env.ACE_ROM ?? join(import.meta.dirname, '../../mcp/.cache/ace.rom');

/**
 * 0000 DI; LD SP,4000h; IM 1; LD HL,2400h; LD DE,2C00h; EI
 * 000D loop: INC (HL) via A; INC HL; at 2700h wrap HL to 2400h and HALT;
 *      IN A,(FEh); OUT (FEh),A; JR loop
 * 0038 IM 1 handler: complement the char-RAM byte at DE, step DE (wrap at
 *      3000h), EI, RETI
 */
function syntheticRom(): Uint8Array {
  const rom = new Uint8Array(0x2000);
  rom.set([
    0xF3, 0x31, 0x00, 0x40, 0xED, 0x56, 0x21, 0x00, 0x24, 0x11, 0x00, 0x2C, 0xFB,
    0x7E, 0x3C, 0x77, 0x23, 0x7C, 0xFE, 0x27, 0x20, 0x04, 0x21, 0x00, 0x24, 0x76,
    0xDB, 0xFE, 0xD3, 0xFE, 0x18, 0xED,
  ], 0);
  rom.set([
    0xF5, 0x1A, 0x2F, 0x12, 0x13, 0x7A, 0xFE, 0x30, 0x20, 0x03, 0x11, 0x00, 0x2C,
    0xF1, 0xFB, 0xED, 0x4D,
  ], 0x38);
  return rom;
}

function machine(rom: Uint8Array, pack = '48k'): JupiterAceMachine {
  const m = new JupiterAceMachine('jupiter-ace', null);
  m.start = async () => {};
  m.prepare({ get: <T>(key: string, fallback: T): T => (key === 'ace-ram-pack' ? pack as T : fallback) });
  m.loadROM(rom);
  m.reset();
  return m;
}

describe('Jupiter Ace .acestate', () => {
  it('is offered for saving and loading', () => {
    const m = machine(syntheticRom());
    try {
      expect(m.services.snapshots.formats()).toEqual([
        { ext: '.acestate', canSave: true }, { ext: '.ace', canSave: false },
      ]);
      const accepts = m.services.media.accepts().map(t => t.ext);
      expect(accepts).toContain('.acestate');
      expect(accepts).toContain('.ace');
      expect(m.descriptor.ui.saveMenu).toContain('snapshot-acestate');
    } finally {
      m.destroy();
    }
  });

  it('resumes exactly (synthetic ROM)', async () => {
    await expectExactResume({
      make: () => machine(syntheticRom()),
      ext: '.acestate',
      before: 37,
      after: 23,
      scramble: m => { for (let a = 0x2400; a < 0x4000; a++) m.memory.writeByte(a, a * 7); m.cpu.pc = 0x1234; },
    });
  });

  it('resumes exactly with no RAM pack', async () => {
    await expectExactResume({
      make: () => machine(syntheticRom(), 'none'),
      ext: '.acestate',
      before: 11,
      after: 9,
    });
  });

  it.skipIf(!existsSync(ROM_PATH))('resumes exactly on the FORTH ROM', async () => {
    const rom = new Uint8Array(readFileSync(ROM_PATH));
    await expectExactResume({ make: () => machine(rom), ext: '.acestate', before: 120, after: 50 });
  });

  it('refuses a damaged file and leaves the machine alone', async () => {
    await expectDamagedRefused(() => machine(syntheticRom()), '.acestate');
  });

  it('refuses a state saved with another RAM pack, changing nothing', async () => {
    const src = machine(syntheticRom(), '16k');
    const dst = machine(syntheticRom(), '48k');
    try {
      for (let f = 0; f < 4; f++) src.tick();
      for (let f = 0; f < 6; f++) dst.tick();
      const before = observe(dst);
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.acestate'), 'x.acestate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/16K RAM pack.*48K/);
      expect(observe(dst)).toEqual(before);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });
});

/** RLE-encode a memory image the way the format describes (ED nn bb runs,
 *  every ED byte escaped, ED 00 to end). */
function aceEncode(mem: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < mem.length;) {
    let run = 1;
    while (i + run < mem.length && mem[i + run] === mem[i] && run < 240) run++;
    if (run >= 3 || mem[i] === 0xED) {
      const n = mem[i] === 0xED ? Math.max(1, Math.min(run, 240)) : run;
      out.push(0xED, n, mem[i]);
      i += n;
    } else {
      out.push(mem[i]);
      i++;
    }
  }
  out.push(0xED, 0x00);
  return Uint8Array.from(out);
}

function put32(mem: Uint8Array, addr: number, v: number): void {
  const o = addr - 0x2000;
  mem[o] = v & 0xFF; mem[o + 1] = (v >> 8) & 0xFF; mem[o + 2] = 0; mem[o + 3] = 0;
}

describe('Jupiter Ace .ace (xAce) snapshots', () => {
  /** A 19K (16K pack) image: RAMTOP 8000h, so memory runs 2000h-7FFFh. */
  function image(): Uint8Array {
    const mem = new Uint8Array(0x6000);
    put32(mem, 0x2080, 0x8000);
    put32(mem, 0x2100, 0x1234); put32(mem, 0x2104, 0x5678); put32(mem, 0x2108, 0x9ABC);
    put32(mem, 0x210C, 0xDEF0); put32(mem, 0x2110, 0x1111); put32(mem, 0x2114, 0x2222);
    put32(mem, 0x2118, 0x7F00); put32(mem, 0x211C, 0x0C00);
    put32(mem, 0x2120, 0xAA55); put32(mem, 0x2124, 0x0102); put32(mem, 0x2128, 0x0304);
    put32(mem, 0x212C, 0x0506);
    put32(mem, 0x2130, 1); put32(mem, 0x2134, 1); put32(mem, 0x2138, 1);
    put32(mem, 0x213C, 0x3F); put32(mem, 0x2140, 0x45);
    // Screen file, character RAM, main RAM and the pack, each its real address.
    mem[0x2400 - 0x2000] = 0x41;
    mem[0x2C08 - 0x2000] = 0x7E;
    mem[0x3C10 - 0x2000] = 0xED;   // an escaped literal
    mem.fill(0x99, 0x5000 - 0x2000, 0x5000 - 0x2000 + 600);  // a run longer than 240
    mem[0x7FFF - 0x2000] = 0x5A;
    return mem;
  }

  it('decodes the run-length encoding and the register block', () => {
    const snap = parseAceSnapshot(aceEncode(image()));
    expect(snap.memory.length).toBe(0x6000);
    expect(snap.memory[0x5000 - 0x2000 + 599]).toBe(0x99);
    expect(snap.memory[0x5000 - 0x2000 + 600]).toBe(0);
    expect(snap.memory[0x3C10 - 0x2000]).toBe(0xED);
    expect(snap.regs).toEqual({
      af: 0x1234, bc: 0x5678, de: 0x9ABC, hl: 0xDEF0, ix: 0x1111, iy: 0x2222,
      sp: 0x7F00, pc: 0x0C00, af_: 0xAA55, bc_: 0x0102, de_: 0x0304, hl_: 0x0506,
      im: 1, iff1: true, iff2: true, i: 0x3F, r: 0x45,
    });
  });

  it('refuses a file with no end marker or a memory size no Ace has', () => {
    const file = aceEncode(image());
    expect(() => parseAceSnapshot(file.subarray(0, file.length - 2))).toThrow(/truncated/);
    expect(() => parseAceSnapshot(Uint8Array.from([1, 2, 3, 0xED, 0]))).toThrow(/Not a Jupiter Ace snapshot/);
  });

  it('loads memory at its real addresses and the CPU, through the media service', async () => {
    const m = machine(syntheticRom(), '48k');
    try {
      const result = await m.services.media.mount(aceEncode(image()), 'game.ace');
      expect(result.ok, result.message).toBe(true);
      expect(m.memory.getVram()[0]).toBe(0x41);
      expect(m.memory.getCharRam()[0x008]).toBe(0x7E);
      expect(m.memory.readByte(0x3C10)).toBe(0xED);
      expect(m.memory.readByte(0x5000)).toBe(0x99);
      expect(m.memory.readByte(0x7FFF)).toBe(0x5A);
      expect(m.cpu.pc).toBe(0x0C00);
      expect(m.cpu.sp).toBe(0x7F00);
      expect(m.cpu.af).toBe(0x1234);
      expect(m.cpu.a_).toBe(0xAA); expect(m.cpu.f_).toBe(0x55);
      expect(m.cpu.im).toBe(1);
      expect(m.cpu.iff1).toBe(true);
      expect(m.cpu.i).toBe(0x3F);
      expect(m.cpu.r).toBe(0x45);
    } finally {
      m.destroy();
    }
  });

  it('refuses a 19K snapshot on a 3K Ace, changing nothing', async () => {
    const m = machine(syntheticRom(), 'none');
    try {
      for (let f = 0; f < 3; f++) m.tick();
      const before = observe(m);
      const result = await m.services.snapshots.apply(aceEncode(image()), 'game.ace');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/16K RAM pack/);
      expect(observe(m)).toEqual(before);
    } finally {
      m.destroy();
    }
  });
});
