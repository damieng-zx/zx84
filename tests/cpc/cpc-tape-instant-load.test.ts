/**
 * Headless regression: the CPC "Fast ROM loading" CAS READ trap on real
 * firmware and a real tape.
 *
 * The firmware's CAS READ (os464 0x2836, os664/os6128 0x29A6) is
 *   CALL setup ; PUSH AF ; LD HL,storeByte ; JR common
 * where `setup` (LD (sync),A ... motor on, PPI setup, RET) is shared with CAS
 * WRITE/CHECK and the bit-level read happens back in CAS READ at `common`. The
 * trap once hooked `setup` and resumed inside it, so after "instant-loading" a
 * block the firmware went on to pulse-read the NEXT block into the same buffer
 * — on the 464 this surfaced as "Read error a" part-way through 1942.
 *
 * Needs the non-redistributable firmware ROMs (mcp/.cache/) and the local tape
 * library; skipped when either is absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { scanCpcCasRead } from '@/machines/cpc/cpc-tape-loader.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import type { CpcModel } from '@/machines/cpc/models.ts';

const CACHE = resolve(__dirname, '../../mcp/.cache');
const TAPE = 'E:/retro/amstrad/cpc/tapes/1942 (E).cdt';
const FIRMWARE: Record<string, [string, string]> = {
  cpc464: ['os464.rom', 'basic1-0.rom'],
  cpc6128: ['os6128.rom', 'basic1-1.rom'],
};
const haveRoms = Object.values(FIRMWARE).flat().every((r) => existsSync(resolve(CACHE, r)));
const rom = (n: string): Uint8Array => new Uint8Array(readFileSync(resolve(CACHE, n)));

describe.skipIf(!haveRoms)('CPC CAS READ routine scan (real firmware)', () => {
  it.each([
    ['os464.rom', 0x2836, 0x2858, 0x28B8, 0x2860],
    ['os664.rom', 0x29A6, 0x29C8, 0x2A28, 0x29D0],
    ['os6128.rom', 0x29A6, 0x29C8, 0x2A28, 0x29D0],
  ])('%s', (file, readEntry, common, storeByte, tail) => {
    if (!existsSync(resolve(CACHE, file))) return;
    expect(scanCpcCasRead(rom(file))).toEqual({ readEntry, common, storeByte, tail });
  });
});

function tap(m: CpcMachine, codes: string[]): void {
  for (const c of codes) m.keyboard.handleKeyEvent(c, true);
  for (let f = 0; f < 3; f++) m.tick();
  for (const c of codes) m.keyboard.handleKeyEvent(c, false);
  for (let f = 0; f < 3; f++) m.tick();
}

describe.skipIf(!haveRoms || !existsSync(TAPE))('CPC instant tape load (1942, real firmware)', () => {
  it.each(['cpc464', 'cpc6128'])('%s: every CAS READ instant-loads and succeeds', (model) => {
    const m = new CpcMachine(model as CpcModel, null);
    const [os, basic] = FIRMWARE[model];
    m.memory.loadRoms(rom(os), rom(basic));   // no AMSDOS: cassette is the default
    m.reset();
    m.tapeFastRom = true;
    for (let f = 0; f < 150; f++) m.tick();

    const blocks = parseTZX(new Uint8Array(readFileSync(TAPE)));
    m.tape.blocks = blocks;
    m.tape.position = 0;
    m.tape.paused = true;
    m.tape.startPlayback();

    // Observe every CAS READ: result (carry) on its return to the caller.
    const cr = scanCpcCasRead(m.memory.getLowerRom())!;
    let pending: { ret: number; sp: number } | null = null;
    let ok = 0, failed = 0;
    m.onTrap = (pc) => {
      if (!m.memory.lowerRomAtZero) return false;
      if (pc === cr.readEntry) {
        const sp = m.cpu.sp;
        pending = { ret: m.memory.readByte(sp) | (m.memory.readByte(sp + 1) << 8), sp };
      } else if (pending && pc === pending.ret && m.cpu.sp === pending.sp + 2) {
        if (m.cpu.f & 1) ok++; else failed++;
        pending = null;
      }
      return false;
    };

    for (const k of [['KeyR'], ['KeyU'], ['KeyN'], ['ShiftLeft', 'Digit2'], ['Enter']]) tap(m, k);
    for (let f = 0; f < 20; f++) m.tick();
    tap(m, ['Enter']);                         // "Press PLAY then any key"

    // Pulse-loading 1942 takes ~40000 frames; instant-loaded it is ~3900.
    for (let f = 0; f < 6000 && m.tape.position < blocks.length; f++) m.tick();

    expect(m.ocrScreenForMcp()).not.toContain('Read error');
    expect(failed).toBe(0);
    expect(ok).toBe(60);                       // 30 header + 30 data records
    expect(m.tape.position).toBe(blocks.length);
  }, 60_000);
});
