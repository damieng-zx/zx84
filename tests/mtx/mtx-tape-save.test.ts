/**
 * Recording what the MTX SAVEs, as a `.mtx` the LOAD trap reads back.
 *
 * The ROM figures the tests rely on come from the OS ROM itself: SAVE writes
 * its header with `CALL 0AAE` at 0BA4 after `LD DE,0014` (20 bytes), LOAD asks
 * for it at 0B55 after `LD DE,0012` (18 bytes), and both then share the body
 * code from 0BB0. The `.mtx` convention is the stream of LOAD requests.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';
import {
  MtxTapeRecorder, MTX_SAVE_HEADER_CALLER, MTX_TAPE_EPILOGUE, MTX_TAPE_ROUTINE,
} from '@/machines/mtx/mtx-tape.ts';
import { parseMtxTapeHeader } from '@/media/tape/mtx.ts';

describe('MtxTapeRecorder', () => {
  const header20 = Uint8Array.from([0xFF, ...Array.from('PROG           ', c => c.charCodeAt(0)), 0x34, 0x12, 0xAA, 0xBB]);

  it('keeps the 18 bytes of the SAVE header that LOAD asks for, then the body as written', () => {
    const r = new MtxTapeRecorder();
    r.record(MTX_SAVE_HEADER_CALLER, header20);
    r.record(0x0BDB, Uint8Array.from([1, 2, 3]));
    r.record(0x0BC0, Uint8Array.from([4]));
    const out = r.bytes()!;
    expect(out.length).toBe(18 + 3 + 1);
    expect(Array.from(out.subarray(16, 22))).toEqual([0x34, 0x12, 1, 2, 3, 4]);
    expect(parseMtxTapeHeader(out)).toEqual({ marker: 0xFF, name: 'PROG', stackLimit: 0x1234 });
  });

  it('starts over on the next SAVE header, and ignores body writes with no header', () => {
    const r = new MtxTapeRecorder();
    r.record(0x0BDB, Uint8Array.from([9, 9]));
    expect(r.bytes()).toBeNull();
    r.record(MTX_SAVE_HEADER_CALLER, header20);
    r.record(0x0BDB, Uint8Array.from([1]));
    r.record(MTX_SAVE_HEADER_CALLER, header20);
    expect(r.bytes()!.length).toBe(18);
    r.reset();
    expect(r.bytes()).toBeNull();
  });
});

describe('MTX SAVE trap', () => {
  it('completes a SAVE request through the routine epilogue and records the block', () => {
    const m = new MtxMachine('mtx512', null);
    m.reset();
    m.memory.writeByte(0xFD68, 0);                 // SAVE
    for (let i = 0; i < 20; i++) m.memory.writeByte(0xC001 + i, i === 0 ? 0xFF : 0x41 + i);
    m.cpu.sp = 0xF000;
    m.memory.writeByte(0xF000, MTX_SAVE_HEADER_CALLER & 0xFF);
    m.memory.writeByte(0xF001, MTX_SAVE_HEADER_CALLER >> 8);
    m.cpu.pc = MTX_TAPE_ROUTINE;
    m.cpu.hl = 0xC001;
    m.cpu.de = 20;

    expect(m.trapCassetteRoutine()).toBe(true);
    expect(m.cpu.pc).toBe(MTX_TAPE_EPILOGUE);
    expect(m.cpu.hl).toBe(0xC015);
    expect(m.cpu.de).toBe(0);
    expect(m.cpu.sp).toBe(0xF000);                // the epilogue's RETI returns
    const saved = m.services.tape!.recordedBytes!()!;
    expect(saved.data.length).toBe(18);
    expect(saved.data[0]).toBe(0xFF);
    expect(saved.data[17]).toBe(0x41 + 17);
  });

  it('leaves a zero-length request to the ROM', () => {
    const m = new MtxMachine('mtx512', null);
    m.reset();
    m.memory.writeByte(0xFD68, 0);
    m.cpu.pc = MTX_TAPE_ROUTINE;
    m.cpu.de = 0;
    expect(m.trapCassetteRoutine()).toBe(false);
    expect(m.services.tape!.recordedBytes!()).toBeNull();
  });

  it('is cleared by a reset', () => {
    const m = new MtxMachine('mtx512', null);
    m.tapeRecorder.record(MTX_SAVE_HEADER_CALLER, new Uint8Array(20).fill(0xFF));
    m.reset();
    expect(m.services.tape!.recordedBytes!()).toBeNull();
  });
});

// ── Real ROM round trip ─────────────────────────────────────────────────

const CACHE = process.env.MTX_ROM_DIR ?? resolve(__dirname, '../../mcp/.cache');
const ROMS = ['os.rom', 'basic.rom', 'assem.rom'];
const haveRoms = ROMS.every(r => existsSync(resolve(CACHE, r)));

function boot(): MtxMachine {
  const m = new MtxMachine('mtx512', null);
  const rom = new Uint8Array(ROMS.length * 0x2000);
  ROMS.forEach((r, i) => rom.set(new Uint8Array(readFileSync(resolve(CACHE, r))), i * 0x2000));
  m.loadROM(rom);
  m.reset();
  for (let f = 0; f < 200; f++) m.tick();
  return m;
}

function type(m: MtxMachine, text: string): void {
  for (const ch of text) {
    const ev = ch === '\n'
      ? { key: 'Enter', code: 'Enter', shift: false, ctrl: false, alt: false }
      : { key: ch, code: '', shift: false, ctrl: false, alt: false };
    m.keyboard.handleEvent(ev, true);
    for (let f = 0; f < 4; f++) m.tick();
    m.keyboard.handleEvent(ev, false);
    for (let f = 0; f < (ch === '\n' ? 60 : 4); f++) m.tick();
  }
}

const screen = (m: MtxMachine): string => m.ocrScreenStyled().text;

describe.skipIf(!haveRoms)('MTX SAVE then LOAD round trip (real ROM; needs os/basic/assem.rom in mcp/.cache)', () => {
  it('records a BASIC SAVE as a .mtx that LOADs back and runs', async () => {
    const m = boot();
    type(m, '10 PRINT 6*7\n');
    type(m, '20 PRINT "OK"\n');
    type(m, 'SAVE "ROUND"\n');
    for (let f = 0; f < 100; f++) m.tick();

    const saved = m.services.tape!.recordedBytes!();
    expect(saved).not.toBeNull();
    expect(saved!.filename).toBe('ROUND.mtx');
    const header = parseMtxTapeHeader(saved!.data)!;
    expect(header.marker).toBe(0xFF);
    expect(header.name).toBe('ROUND');
    expect(saved!.data.length).toBeGreaterThan(18);

        // Wipe the program, put the recording in the deck and load it back.
    type(m, 'NEW\n');
    type(m, 'CLS\n');
    type(m, 'RUN\n');
    expect(screen(m)).not.toMatch(/^\s*OK\s*$/m);
    expect(await m.services.tape!.mountBytes(saved!.data, saved!.filename)).toBe(true);
    type(m, 'LOAD "ROUND"\n');
    for (let f = 0; f < 100; f++) m.tick();
    type(m, 'CLS\n');
    type(m, 'RUN\n');
    const out = screen(m);
    expect(out).toMatch(/^\s*42\s*$/m);
    expect(out).toMatch(/^\s*OK\s*$/m);

    // The program SAVEd again is byte for byte the same stream.
    type(m, 'SAVE "ROUND"\n');
    for (let f = 0; f < 100; f++) m.tick();
    expect(Array.from(m.services.tape!.recordedBytes!()!.data)).toEqual(Array.from(saved!.data));
  });
});
