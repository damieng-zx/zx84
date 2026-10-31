/**
 * SAVE to tape on the ZX80/ZX81, recorded as the program image.
 *
 * The real ROMs are run headless: a one-line BASIC program is typed, SAVEd,
 * and what the machine recorded is checked against the documented memory
 * layout — the tape image is RAM from VERSN $4009 (ZX81) or $4000 (ZX80) up
 * to, not including, E_LINE ($4014 on the ZX81, $400A on the ZX80); BASIC
 * starts at $407D (ZX81) or $4028 (ZX80). The image is then played into a
 * freshly booted machine's LOAD through the media service, and the program
 * must come back and RUN.
 *
 * Needs the ROMs (zx81-v2.rom, zx80.rom) in ZX8X_ROM_DIR or mcp/.cache/;
 * each model is skipped when its ROM is absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import type { Zx8xModel } from '@/machines/zx8x/models.ts';

const DIR = process.env.ZX8X_ROM_DIR ?? resolve(__dirname, '../../mcp/.cache');
const ROMS: Record<Zx8xModel, string> = { zx81: 'zx81-v2.rom', zx80: 'zx80.rom' };
const have = (model: Zx8xModel): boolean => existsSync(resolve(DIR, ROMS[model]));

function boot(model: Zx8xModel): Zx8xMachine {
  const m = new Zx8xMachine(model);
  m.loadROM(new Uint8Array(readFileSync(resolve(DIR, ROMS[model]))));
  m.reset();
  for (let f = 0; f < 200; f++) m.tick();
  return m;
}

type Key = string | string[];

/** Press and release one key (a chord when given an array). */
function press(m: Zx8xMachine, codes: Key): void {
  const keys = Array.isArray(codes) ? codes : [codes];
  for (const k of keys) m.keyboard.handleKeyEvent(k, true);
  for (let f = 0; f < 6; f++) m.tick();
  for (const k of [...keys].reverse()) m.keyboard.handleKeyEvent(k, false);
  for (let f = 0; f < 6; f++) m.tick();
}

function type(m: Zx8xMachine, seq: Key[]): void {
  for (const k of seq) press(m, k);
  for (let f = 0; f < 30; f++) m.tick();
}

const QUOTE: Key = ['ShiftLeft', 'KeyP'];   // ZX81: SHIFT+P is "
const word = (m: Zx8xMachine, a: number): number => m.memory.readByte(a) | (m.memory.readByte(a + 1) << 8);
const ram = (m: Zx8xMachine, from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => m.memory.readByte(from + i));
const le = (d: Uint8Array, o: number): number => d[o] | (d[o + 1] << 8);

function screen(m: Zx8xMachine): string {
  const mem = new Uint8Array(0x10000);
  for (let a = 0; a < 0x10000; a++) mem[a] = m.memory.readByte(a);
  return m.screenText.ocr(mem, m.model);
}

describe.skipIf(!have('zx81'))('ZX81 SAVE recording (real ROM; skipped without zx81-v2.rom)', () => {
  it('records SAVE "AB" as a .p image that LOADs back', async () => {
    const m = boot('zx81');
    expect(m.services.tape.recordedBytes()).toBeNull();
    // 10 PRINT 42 — in K mode P is PRINT.
    type(m, ['Digit1', 'Digit0', 'KeyP', 'Digit4', 'Digit2', 'Enter']);
    const program = ram(m, 0x407d, word(m, 0x400c));     // BASIC: $407D up to D_FILE
    // SAVE "AB" — in K mode S is SAVE.
    type(m, ['KeyS', QUOTE, 'KeyA', 'KeyB', QUOTE, 'Enter']);

    const rec = m.services.tape.recordedBytes();
    expect(rec).not.toBeNull();
    const { data, filename } = rec!;
    expect(filename).toBe('AB.p');
    // The image is $4009 up to E_LINE, and carries E_LINE itself at $4014.
    expect(0x4009 + data.length).toBe(le(data, 0x4014 - 0x4009));
    expect(data[0]).toBe(0);                                // VERSN
    // D_FILE follows the program: 10 PRINT 42 is 2 (line no.) + 2 (length)
    // + PRINT, "4", "2", the 6-byte hidden number and NEWLINE = 14 bytes.
    expect(le(data, 0x400c - 0x4009)).toBe(0x407d + 14);
    const line = Array.from(data.subarray(0x407d - 0x4009, 0x407d - 0x4009 + 14));
    expect(line.slice(0, 4)).toEqual([0x00, 0x0a, 10, 0]);  // line 10 (big-endian), length 10
    expect(line.slice(4, 7)).toEqual([0xf5, 0x20, 0x1e]);   // PRINT 4 2
    expect(line[7]).toBe(0x7e);                             // number marker
    expect(line[13]).toBe(0x76);                            // NEWLINE

    // A fresh machine's LOAD "" reads it back.
    const n = boot('zx81');
    type(n, ['KeyJ', QUOTE, QUOTE, 'Enter']);                // LOAD ""
    expect(n.awaitingTapeLoad).toBe(true);
    const mounted = await n.services.media.mount(data, filename);
    expect(mounted.ok).toBe(true);
    for (let f = 0; f < 60; f++) n.tick();
    expect(ram(n, 0x407d, word(n, 0x400c))).toEqual(program);
    type(n, ['KeyR', 'Enter']);                              // RUN
    expect(screen(n)).toMatch(/^42/);
  });

  it('forgets the recording on reset', () => {
    const m = boot('zx81');
    type(m, ['Digit1', 'Digit0', 'KeyP', 'Digit4', 'Digit2', 'Enter']);
    type(m, ['KeyS', QUOTE, 'KeyA', QUOTE, 'Enter']);
    expect(m.services.tape.recordedBytes()).not.toBeNull();
    m.reset();
    expect(m.services.tape.recordedBytes()).toBeNull();
  });
});

describe.skipIf(!have('zx80'))('ZX80 SAVE recording (real ROM; skipped without zx80.rom)', () => {
  it('records SAVE as a .o image that LOADs back', async () => {
    const m = boot('zx80');
    expect(m.services.tape.recordedBytes()).toBeNull();
    // 10 PRINT 42 — on the ZX80 PRINT is on O, SAVE on E, LOAD on W, RUN on R.
    type(m, ['Digit1', 'Digit0', 'KeyO', 'Digit4', 'Digit2', 'Enter']);
    const program = ram(m, 0x4028, word(m, 0x4008));     // BASIC: $4028 up to VARS
    type(m, ['KeyE', 'Enter']);

    const rec = m.services.tape.recordedBytes();
    expect(rec).not.toBeNull();
    const { data, filename } = rec!;
    expect(filename).toBe('zx80.o');
    // The image is $4000 up to E_LINE, and carries E_LINE itself at $400A.
    expect(0x4000 + data.length).toBe(le(data, 0x400a - 0x4000));
    // VARS follows the program; a ZX80 line is number (big-endian), tokens,
    // NEWLINE with no length field: 00 0A, PRINT, "4", "2", 76 = 6 bytes.
    const vars = le(data, 0x4008 - 0x4000);
    expect(vars).toBe(0x4028 + 6);
    const line = Array.from(data.subarray(0x28, 0x28 + 6));
    expect(line.slice(0, 2)).toEqual([0x00, 0x0a]);
    expect(line[2]).toBeGreaterThanOrEqual(0xd4);            // a keyword token
    expect(line.slice(3)).toEqual([0x20, 0x1e, 0x76]);       // 4 2 NEWLINE
    expect(data[vars - 0x4000]).toBe(0x80);                  // empty variables area

    const n = boot('zx80');
    type(n, ['KeyW', 'Enter']);                              // LOAD
    expect(n.awaitingTapeLoad).toBe(true);
    const mounted = await n.services.media.mount(data, filename);
    expect(mounted.ok).toBe(true);
    for (let f = 0; f < 60; f++) n.tick();
    expect(ram(n, 0x4028, word(n, 0x4008))).toEqual(program);
    type(n, ['KeyR', 'Enter']);                              // RUN
    expect(screen(n)).toMatch(/^42/);
  });

  it('the real LOAD reads that .o played as pulses with the instant trap off', async () => {
    const saver = boot('zx80');
    type(saver, ['Digit1', 'Digit0', 'KeyO', 'Digit4', 'Digit2', 'Enter']);
    const program = ram(saver, 0x4028, word(saver, 0x4008));
    type(saver, ['KeyE', 'Enter']);                          // SAVE
    const rec = saver.services.tape.recordedBytes()!;

    const m = new Zx8xMachine('zx80');
    m.prepare({ get: <T>(key: string, fallback: T): T => (key === 'tape-instant-rom' ? false as T : fallback) });
    m.loadROM(new Uint8Array(readFileSync(resolve(DIR, ROMS.zx80))));
    m.reset();
    for (let f = 0; f < 200; f++) m.tick();
    type(m, ['KeyW', 'Enter']);                              // LOAD
    expect(m.awaitingTapeLoad).toBe(true);
    expect((await m.services.media.mount(rec.data, rec.filename)).ok).toBe(true);
    // Real time: the ROM reads the deck, so nothing is in RAM yet.
    expect(ram(m, 0x4028, 0x4028 + 4)).not.toEqual(program.slice(0, 4));
    for (let f = 0; f < 2000 && !m.cassette.deck.finished; f++) m.tick();
    for (let f = 0; f < 60; f++) m.tick();
    expect(ram(m, 0x4028, word(m, 0x4008))).toEqual(program);
    type(m, ['KeyR', 'Enter']);                              // RUN
    expect(screen(m)).toMatch(/^42/);
  });
});

describe('ZX81 recorded filename', () => {
  /** Just enough ROM for the SAVE trap's signature check (see tape-trap.test). */
  function trapRom(): Uint8Array {
    const rom = new Uint8Array(0x2000);
    rom.set([0xcd, 0xa8, 0x03, 0xcb, 0x12, 0xcb, 0x0a, 0xcd, 0x4c, 0x03], 0x0340);
    rom.set([0x62, 0x6b, 0xcd, 0x4c, 0x03], 0x0364);
    rom.set([0xcd, 0xa8, 0x03, 0x38, 0xf9, 0xeb], 0x02f6);
    rom.set([0x21, 0x3b, 0x40, 0x76], 0x0207);
    return rom;
  }

  it('replaces characters a host filename cannot carry', () => {
    const m = new Zx8xMachine('zx81');
    m.loadROM(trapRom());
    m.cpu.pc = 0x02fb;
    m.cpu.sp = 0x43f0;
    m.breakpoints.add(0x020a);
    // "A/B" in ZX81 codes: A=$26, /=$18, B=$27 (last with bit 7 set).
    [0x26, 0x18, 0x27 | 0x80].forEach((c, i) => m.memory.writeByte(0x4200 + i, c));
    m.cpu.d = 0x42; m.cpu.e = 0x00;
    m.memory.writeByte(0x4014, 0x0c);   // E_LINE = $400C: a 3-byte image
    m.memory.writeByte(0x4015, 0x40);
    m.tick();
    expect(m.services.tape.recordedBytes()?.filename).toBe('A_B.p');
  });
});
