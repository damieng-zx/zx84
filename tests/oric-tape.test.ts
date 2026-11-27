/**
 * Oric cassette: the `.tap` codec, the deck, and what the ROM's own `CSAVE`
 * puts on the wire.
 *
 * The codec tests are built from the format's definition (leader, sync, nine-byte
 * header, NUL-terminated name, payload) with hand-computed bytes, never by
 * round-tripping through the code under test. The SAVE test pins what the real
 * ROM reports so a future decoder starts from measurement.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildOricTap, isOricTap, oricTapFor, parseOricTap,
  ORIC_TAP_AUTORUN, ORIC_TAP_DEFAULT_LEADER, ORIC_TAP_LEADER, ORIC_TAP_SYNC,
} from '@/media/tape/oric-tap.ts';
import { OricMachine } from '@/machines/oric/oric-machine.ts';
import { OricTapeEncoder } from '@/machines/oric/oric-tape.ts';

const CACHE = join(process.cwd(), 'mcp', '.cache');
const ATMOS_ROM = 'oric-basic11b.rom';
const hasRom = (name: string): boolean => existsSync(join(CACHE, name));
const rom = (name: string): Uint8Array => new Uint8Array(readFileSync(join(CACHE, name)));

/** The exact bytes a one-file tape must be, worked out by hand. */
function handBuiltTap(): Uint8Array {
  // Three leader bytes, the sync, then the nine-byte header at 4..12:
  //   [0][1] unused  [2] type  [3] autorun  [4..5] end  [6..7] start  [8] unused
  // name "AB" + NUL, then the payload. start $0501, end $0503 -> three bytes.
  return Uint8Array.from([
    ORIC_TAP_LEADER, ORIC_TAP_LEADER, ORIC_TAP_LEADER,     // 0..2 leader
    ORIC_TAP_SYNC,                                          // 3 sync
    0x00, 0x00,                                             // 4..5 unused
    0x00,                                                   // 6 type: BASIC
    0x00,                                                   // 7 autorun: no
    0x05, 0x03,                                             // 8..9 end $0503
    0x05, 0x01,                                             // 10..11 start $0501
    0x00,                                                   // 12 unused
    0x41, 0x42, 0x00,                                       // 13..15 "AB" + NUL
    0xDE, 0xAD, 0xBE,                                       // 16..18 payload
  ]);
}

describe('oric .tap codec', () => {
  it('reads the layout the format defines', () => {
    const files = parseOricTap(handBuiltTap());
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file.name).toBe('AB');
    expect(file.type).toBe(0x00);
    expect(file.autorun).toBe(false);
    expect(file.start).toBe(0x0501);
    expect(file.end).toBe(0x0503);
    expect(file.leaderLength).toBe(3);
    expect(Array.from(file.data)).toEqual([0xDE, 0xAD, 0xBE]);
  });

  it('writes back byte-identical', () => {
    const original = handBuiltTap();
    expect(Array.from(buildOricTap(parseOricTap(original)))).toEqual(Array.from(original));
  });

  it('round-trips several files, each with its own leader', () => {
    const first = parseOricTap(oricTapFor('ONE', 0x0501, Uint8Array.from([1, 2])))[0];
    const second = parseOricTap(oricTapFor('TWO', 0xA000, Uint8Array.from([3, 4, 5])))[0];
    const tap = buildOricTap([first, second]);
    const back = parseOricTap(tap);
    expect(back.map(f => f.name)).toEqual(['ONE', 'TWO']);
    expect(back.map(f => f.start)).toEqual([0x0501, 0xA000]);
    expect(back.map(f => Array.from(f.data))).toEqual([[1, 2], [3, 4, 5]]);
    // Two leader runs, so the sync byte appears once per file.
    expect(tap.filter(b => b === ORIC_TAP_SYNC)).toHaveLength(2);
  });

  it('marks an autorun file, which is what $C7 means', () => {
    const tap = buildOricTap([{
      type: 0x00, autorun: true, start: 0x0501, end: 0x0501,
      name: 'X', data: Uint8Array.from([0]), leaderLength: ORIC_TAP_DEFAULT_LEADER,
    }]);
    // Leader (3) + sync (1) + the header's first three bytes: the autorun flag
    // is header byte 3, so index 3 + 1 + 3 = 7.
    expect(tap[7]).toBe(ORIC_TAP_AUTORUN);
    expect(parseOricTap(tap)[0].autorun).toBe(true);
  });

  it('refuses the malformed images a loader would choke on', () => {
    // No leader.
    expect(() => parseOricTap(Uint8Array.from([0x24, 1, 2, 3])))
      .toThrow(/no leader/);
    // Leader then the wrong byte.
    expect(() => parseOricTap(Uint8Array.from([0x16, 0x99])))
      .toThrow(/sync byte/);
    // A name with no terminator in the whole 18-byte name window.
    const noName = Uint8Array.from([
      0x16, 0x24,
      0, 0, 0, 0, 0x05, 0x01, 0x05, 0x01, 0,       // header, payload 1 byte
      ...Array.from({ length: 18 }, () => 0x41),    // 18 name bytes, no NUL
      0x00,
    ]);
    expect(() => parseOricTap(noName)).toThrow(/unterminated name/);
    // A payload shorter than its address range declares.
    const short = handBuiltTap().slice(0, 18);
    expect(() => parseOricTap(short)).toThrow(/truncated/);
    // A reversed address range.
    const reversed = handBuiltTap();
    reversed[8] = 0x01; reversed[9] = 0x00;   // end $0001, start $0501
    expect(() => parseOricTap(reversed)).toThrow(/reversed address range/);
  });

  it('is tellable apart from the Spectrum .tap that shares the extension', () => {
    // The Spectrum's .tap has no leader/sync framing at all.
    expect(isOricTap(Uint8Array.from([0x13, 0x00, 0x00, 0xAA, 0xBB]))).toBe(false);
    expect(isOricTap(handBuiltTap())).toBe(true);
    // A leader run with no sync after it is not an Oric tape either.
    expect(isOricTap(Uint8Array.from([0x16, 0x16]))).toBe(false);
  });

  it('refuses to build a name the ROM could not load', () => {
    const long = { type: 0, autorun: false, start: 0x501, end: 0x501, name: 'A'.repeat(18), data: Uint8Array.from([1]), leaderLength: 3 };
    expect(() => buildOricTap([long])).toThrow(/17 characters/);
  });
});

describe('oric tape deck', () => {
  it('synthesises the two tones the loader reads', () => {
    // Measured from the real ROM: 2400 Hz and 1200 Hz half-cycles at 1 MHz.
    const enc = new OricTapeEncoder(1_000_000);
    const pulses = enc.bytePulses(0x00).map(p => p.cycles);
    // Every half-cycle belongs to one of the two tones.
    for (const p of pulses) {
      expect([209, 417, 208, 208].some(v => Math.abs(p - v) <= 2),
        `half-cycle of ${p} cycles is neither tone`).toBe(true);
    }
  });

  it('mounts an image and reports its files', async () => {
    const m = new OricMachine('atmos', null);
    try {
      const before = m.services.tape.loaded;
      expect(before).toBe(false);
      const ok = await m.services.tape.mountBytes(oricTapFor('DEMO', 0x0501, Uint8Array.from([1, 2, 3])), 'DEMO.tap');
      expect(ok).toBe(true);
      expect(m.services.tape.loaded).toBe(true);
      expect(m.services.tape.blocks).toHaveLength(1);
      expect(m.services.tape.blocks[0].label).toBe('DEMO');
      expect(m.services.tape.command).toBe('CLOAD "DEMO"');
      m.services.tape.eject();
      expect(m.services.tape.loaded).toBe(false);
    } finally {
      m.destroy();
    }
  });
});

describe.runIf(hasRom(ATMOS_ROM))('oric CSAVE', () => {
  it('drives the two tones the reference gives, at the right clock', () => {
    // A real SAVE is slow by nature: the ROM writes ~7,600 half-cycles at the
    // tape's own rate, and the run also waits for the typed command to drain.
    // The default 5 s test timeout is not enough for that under a loaded suite,
    // so this test states its own budget rather than racing it.
    const m = new OricMachine('atmos', null);
    try {
      m.loadROM(rom(ATMOS_ROM));
      m.reset();
      for (let i = 0; i < 200; i++) m.tick();
      m.typeText('A=1\n');
      for (let i = 0; i < 800; i++) m.tick();
      // Start from a clean recorder: another test's PING leaves pulses in it,
      // and the tone populations are measured over *this* SAVE.
      m.tape.recorder.reset();
      m.typeText('CSAVE "Q"\n');
      // Wait for the paste to drain and the ROM to act, rather than guessing a
      // frame count: under a loaded suite the same count can fall short.
      for (let i = 0; i < 20_000 && m.pasteRemaining > 0; i++) m.tick();
      for (let i = 0; i < 500; i++) m.tick();

      const pulses = Array.from(m.tape.recorder.pulses(m.cpu.tStates))
        .filter(p => p < 2_000_000);      // drop the leading silence
      expect(pulses.length, 'CSAVE must move the data line').toBeGreaterThan(100);

      const short = pulses.filter(p => p <= 312);
      const long = pulses.filter(p => p > 312);
      expect(short.length).toBeGreaterThan(100);
      expect(long.length).toBeGreaterThan(100);
      // 1 MHz ÷ (2 × 209) ≈ 2392 Hz and 1 MHz ÷ (2 × 417) ≈ 1199 Hz.
      const median = (xs: number[]): number => xs.sort((a, b) => a - b)[xs.length >> 1];
      expect(median(short)).toBeGreaterThanOrEqual(205);
      expect(median(short)).toBeLessThanOrEqual(215);
      expect(median(long)).toBeGreaterThanOrEqual(412);
      expect(median(long)).toBeLessThanOrEqual(422);
    } finally {
      m.destroy();
    }
    // 20 s: this machine SAVEs in real time, and the harness may be loaded.
  }, 20_000);
});
