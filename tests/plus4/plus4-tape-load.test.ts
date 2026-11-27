/**
 * The Plus/4's cassette wiring and half-wave tape format, through the real
 * KERNAL.
 *
 * The 7501's port bit 4 is the Datasette's **read line** — the tape signal —
 * while the PLAY sense is a steady deck-button level on PIO 1 bit 2. The
 * machine once drove bit 4 from the PLAY sense, which never moves while a
 * tape runs, so the KERNAL's reader (`tapred.src`: "wait till rd line is high
 * … wait till it's low") spun forever and a LOAD could not even start.
 *
 * The port fix got the KERNAL reading, but the C16/Plus/4 writes a half-wave
 * tape (VICE's .tap version 2): both halves of every dipole are timed, and a
 * bit is carried by *which* half is short (0 = short-short-long-long,
 * 1 = long-long-short-short, a word marker = marker-marker-long-long). These
 * tests pin the whole path with the real ROMs under mcp/.cache (gitignored;
 * the app fetches them): a generated .prg LOADs, and a KERNAL SAVE round-trips
 * through `recordedBytes()` and back onto a fresh machine.
 */

import { describe, expect, it } from 'vitest';
import { Plus4Machine } from '@/machines/plus4/plus4-machine.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';

const kernal = romImage('plus4/kernal-318004-05.rom');
const basic = romImage('plus4/basic-318006-01.rom');
const funcLow = romImage('plus4/3plus1-317053-01.rom');
const funcHigh = romImage('plus4/3plus1-317054-01.rom');

const haveRoms = !!(kernal && basic && funcLow && funcHigh);

function realPlus4(): Plus4Machine {
  const rom = new Uint8Array(0x10000);
  rom.set(kernal!, 0);
  rom.set(basic!, 0x4000);
  rom.set(funcLow!, 0x8000);
  rom.set(funcHigh!, 0xC000);
  const m = new Plus4Machine('plus4', null, false);
  m.loadROM(rom);
  m.reset();
  for (let f = 0; f < 150; f++) m.tick();
  return m;
}

/** Key by key as the C64 test does, with enough frames for the Plus/4's
 *  slower keyboard scan to see each press and release. */
function typeText(m: Plus4Machine, text: string): void {
  for (const ch of text) {
    const ev = ch === '\n'
      ? { code: 'Enter', key: 'Enter', shift: false, ctrl: false, alt: false }
      : { code: '', key: ch, shift: false, ctrl: false, alt: false };
    m.services.input.keyDown(ev);
    for (let f = 0; f < 8; f++) m.tick();
    m.services.input.keyUp(ev);
    for (let f = 0; f < (ch === '\n' ? 12 : 8); f++) m.tick();
  }
}

/** Run until `done` holds, or give up after `maxFrames`; returns the frames run. */
function runUntil(m: Plus4Machine, done: (screen: string) => boolean, maxFrames: number): number {
  let frames = 0;
  while (!done(m.ocrScreenForMcp()) && frames < maxFrames) { m.tick(); frames++; }
  return frames;
}

/** Wait for the READY prompt that follows the loaded/searched tape. */
function runUntilReady(m: Plus4Machine, maxFrames: number): number {
  return runUntil(m, s => /READY\.\s*$/.test(s) && /FOUND/.test(s), maxFrames);
}

/** 10 PRINT "B", as a BASIC 3.5 .prg ($1001 + linked lines). */
const bPrg = Uint8Array.from([
  0x01, 0x10, 0x0A, 0x10, 0x0A, 0x00, 0x99, 0x22, 0x42, 0x22, 0x00, 0x00, 0x00,
]);

describe.skipIf(!haveRoms)('Plus/4 Datasette with the real ROMs', () => {
  it('boots to BASIC 3.5', () => {
    expect(realPlus4().ocrScreenForMcp()).toContain('READY');
  }, 60_000);

  it('loads a dropped program through the real KERNAL', { timeout: 120_000 }, async () => {
    const m = realPlus4();
    const r = await m.services.media.mount(bPrg, 'b.prg');
    expect(r).toMatchObject({ ok: true, target: 'tape' });

    const tape = m.services.tape;
    expect(tape.loaded).toBe(true);
    // The half-wave decoder names the header and the data block.
    expect(tape.blocks.map(b => b.label)).toEqual(['"B"', 'Data (11 bytes)']);

    // Let BASIC settle at its prompt before typing.
    for (let f = 0; f < 50; f++) m.tick();
    typeText(m, 'LOAD\n');
    const screen = (): string => m.ocrScreenForMcp();
    // The KERNAL asks for PLAY and begins searching; auto-PLAY starts the deck.
    expect(runUntil(m, s => /SEARCHING/.test(s), 12_000)).toBeLessThan(12_000);
    expect(screen(), 'the KERNAL asked for the tape').toContain('PRESS PLAY ON TAPE');
    expect(m.tape.playing, 'auto-PLAY started the deck').toBe(true);

    // And now it must find the header, load the data and return to BASIC.
    expect(runUntilReady(m, 12_000), 'the KERNAL found and loaded the file').toBeLessThan(12_000);
    expect(screen()).toContain('FOUND B');

    typeText(m, 'LIST\n');
    for (let f = 0; f < 20; f++) m.tick();
    expect(screen()).toContain('10 PRINT"B"');
  });

  it('loads back what it saved to tape, through the KERNAL both ways', { timeout: 180_000 }, async () => {
    const m = realPlus4();
    for (let f = 0; f < 50; f++) m.tick();
    typeText(m, '10 PRINT "FROM TAPE"\nSAVE "T"\n');
    expect(runUntil(m, s => /READY\.\s*$/.test(s) && /SAVING/.test(s), 12_000)).toBeLessThan(12_000);
    const saved = m.services.tape.recordedBytes();
    expect(saved).not.toBeNull();
    expect(saved!.data[12], 'a half-wave, version-2 .tap').toBe(2);

    const m2 = realPlus4();
    const r = await m2.services.media.mount(saved!.data, saved!.filename);
    expect(r.ok, r.message).toBe(true);
    expect(m2.services.tape.blocks[0].label).toBe('"T"');

    typeText(m2, 'LOAD\n');
    expect(runUntilReady(m2, 12_000), 'the KERNAL found and loaded the file').toBeLessThan(12_000);
    expect(m2.ocrScreenForMcp()).toContain('FOUND T');
    typeText(m2, 'RUN\n');
    for (let f = 0; f < 20; f++) m2.tick();
    expect(m2.ocrScreenForMcp()).toMatch(/RUN\nFROM TAPE/);
  });
});
