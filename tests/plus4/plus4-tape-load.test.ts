/**
 * The Plus/4's cassette wiring, through the real KERNAL.
 *
 * The 7501's port bit 4 is the Datasette's **read line** — the tape signal —
 * while the PLAY sense is a steady deck-button level on PIO 1 bit 2. The
 * machine drove bit 4 from the PLAY sense, which never moves while a tape runs,
 * so the KERNAL's reader (`tapred.src`: "wait till rd line is high … wait till
 * it's low") spun forever and a LOAD could not even start.
 *
 * These tests pin what the wiring must do, using the real ROMs under
 * mcp/.cache (gitignored; the app fetches them).
 *
 * NOT covered here: the KERNAL's byte reader still does not decode our
 * generated tapes. The C16 family writes its bits as equal *half-wave* periods
 * (VICE's .tap version 2) rather than C64-style falling-edge pulses, so a
 * complete LOAD needs that format. That is a separate piece of work; this file
 * stops at the point where the tape is engaged and reading.
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

/** Key by key, as the C64 test does: press, let the scan see it, release. */
function typeText(m: Plus4Machine, text: string): void {
  for (const ch of text) {
    const ev = ch === '\n'
      ? { code: 'Enter', key: 'Enter', shift: false, ctrl: false, alt: false }
      : { code: '', key: ch, shift: false, ctrl: false, alt: false };
    m.services.input.keyDown(ev);
    for (let f = 0; f < 3; f++) m.tick();
    m.services.input.keyUp(ev);
    for (let f = 0; f < (ch === '\n' ? 10 : 2); f++) m.tick();
  }
}

/** 10 PRINT "B", as a BASIC 3.5 .prg ($1001 + linked lines). */
const bPrg = Uint8Array.from([
  0x01, 0x10, 0x0A, 0x10, 0x0A, 0x00, 0x99, 0x22, 0x42, 0x22, 0x00, 0x00, 0x00,
]);

describe.skipIf(!haveRoms)('Plus/4 Datasette with the real ROMs', () => {
  it('boots to BASIC 3.5', () => {
    expect(realPlus4().ocrScreenForMcp()).toContain('READY');
  }, 60_000);

  it('gets the KERNAL as far as reading the tape on LOAD', { timeout: 120_000 }, async () => {
    const m = realPlus4();
    const r = await m.services.media.mount(bPrg, 'b.prg');
    expect(r).toMatchObject({ ok: true, target: 'tape' });

    typeText(m, 'NEW\nLOAD\n');
    const screen = (): string => m.ocrScreenForMcp();
    let frames = 0;
    while (!/SEARCHING/.test(screen()) && frames < 12_000) { m.tick(); frames++; }

    // The KERNAL asked for PLAY and then began searching: with the read line
    // stuck on the PLAY sense it never got past its first sense poll.
    expect(screen(), 'the KERNAL asked for the tape').toContain('PRESS PLAY ON TAPE');
    expect(screen(), 'and started reading it').toContain('SEARCHING');

    // Auto-PLAY put the deck in gear, and the read line is now carrying the
    // tape: sample the port across a few frames and it must change level.
    expect(m.tape.playing, 'the deck is running').toBe(true);
    const levels = new Set<number>();
    m.onTrap = () => {
      levels.add((m.memory.readByte(1) & 0x10) !== 0 ? 1 : 0);
      return false;
    };
    for (let f = 0; f < 3; f++) m.tick();
    m.onTrap = null;
    expect([...levels].sort(), 'the read line toggles with the tape').toEqual([0, 1]);
  });
});
