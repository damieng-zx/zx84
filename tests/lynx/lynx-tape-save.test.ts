/**
 * Recording what the Lynx SAVEs, back to the .tap its loader reads.
 *
 * The expected waveform is the tape format as lynx-tap.ts documents it (after
 * MAME's camplynx_cas): per block a leader of 555 zero bytes, the A5 sync
 * byte, then the bytes, MSB first; a bit is one cycle of two equal
 * half-cycles, a 0 two samples of the board's tape rate per half and a 1 four
 * — 4kHz on the 48K (500/1000 µs), 8kHz on the 128K (250/500 µs). A file is a
 * quoted name block, then a data block whose size is fixed by its type letter
 * and a 16-bit length inside it. The pulse trains below are built from those
 * figures, not from the decoder.
 */

import { describe, expect, it } from 'vitest';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';
import type { LynxModel } from '@/machines/lynx/models.ts';
import { TapeDeck, TAPE_REF_HZ } from '@/media/tape/tap.ts';
import {
  decodeLynxSavePulses, encodeLynxTap, parseLynxTap, LYNX_TAPE_HZ_48,
} from '@/media/tape/lynx-tap.ts';

const ascii = (s: string): number[] => Array.from(s, c => c.charCodeAt(0));

/** A 'B' (BASIC) entry: B, len16, body, 3 trailing bytes (MAME: 3 + len + 3). */
function basicEntry(body: number[]): number[] {
  return [0x42, body.length & 0xff, body.length >> 8, ...body, 0x11, 0x22, 0x33];
}

/** An 'M' (machine code) entry: M, len16, body, 7 trailing bytes (3 + len + 7). */
function codeEntry(body: number[]): number[] {
  return [0x4d, body.length & 0xff, body.length >> 8, ...body, 1, 2, 3, 4, 5, 6, 7];
}

/** The blocks of one named file, in the order the ROM writes them. */
function file(name: string, entry: number[]): number[][] {
  return [[0x22, ...ascii(name), 0x22], entry];
}

/** Deterministic +-3% wobble, so the decoder never sees perfect widths. */
function wobble(i: number): number {
  return 1 + (((i * 7919) % 61) - 30) / 1000;
}

/** Half-cycle widths for blocks written at `half0` per 0-bit half-cycle. */
function pulseTrain(blocks: number[][], half0: number, gap: number): number[] {
  const out: number[] = [];
  for (const block of blocks) {
    const bytes = [...new Array(555).fill(0), 0xa5, ...block];
    for (const byte of bytes) {
      for (let bit = 7; bit >= 0; bit--) {
        const w = (byte >> bit) & 1 ? half0 * 2 : half0;
        out.push(Math.round(w * wobble(out.length)), Math.round(w * wobble(out.length + 1)));
      }
    }
    out.push(gap);                     // the silence before the next block
  }
  return out;
}

function machine(model: LynxModel): LynxMachine {
  const m = new LynxMachine(model, null);
  m.loadROM(new Uint8Array(0x4000));
  m.reset();
  return m;
}

/** Drive the cassette output through the ports, edge by edge, with the motor
 *  running: bit 5 of port 0x84, high when clear. The last width is left open
 *  (no edge closes it), as at the end of a real SAVE. */
function play(m: LynxMachine, widths: number[], motorBit: number): void {
  m.cpu.portOut(0x0080, motorBit);
  let t = m.cpu.tStates + 1000;
  let level = 1;
  for (let i = 0; i < widths.length; i++) {
    m.cpu.tStates = t;
    m.cpu.portOut(0x0084, level ? 0x00 : 0x20);
    level ^= 1;
    if (i < widths.length - 1) t += widths[i];
  }
}

describe('Lynx SAVE recording (driven through port 0x84)', () => {
  const tape = [
    ...file('AB', basicEntry([0x0a, 0x00, 0x99, 0x2a, 0x0d])),
    ...file('CODE', codeEntry([0xc3, 0x00, 0x60])),
  ];
  const expected = Uint8Array.from(tape.flat());

  it('48K: two files decode to the exact .tap and mount back', async () => {
    const m = machine('lynx48');
    // A few stray edges first: a click on the line is not a leader.
    play(m, [300, 5000, 1200, 40000, ...pulseTrain(tape, 2000, 4_000_000)], 0x02);

    const saved = m.services.tape!.recordedBytes!()!;
    expect(saved).not.toBeNull();
    expect(Array.from(saved.data)).toEqual(Array.from(expected));
    expect(saved.filename).toBe('AB.tap');

    const entries = parseLynxTap(saved.data).entries;
    expect(entries.map(e => [e.name, e.type])).toEqual([['AB', 'B'], ['CODE', 'M']]);
    expect(await m.services.tape!.mountBytes(saved.data, saved.filename)).toBe(true);
    expect(m.services.tape!.blocks.length).toBe(4);
  });

  it('128K: the same tape at the 128K rate (8kHz on a 6MHz clock) decodes too', () => {
    const m = machine('lynx128');
    // 0-bit half-cycle: 2 samples at 8kHz = 250 µs = 1500 T-states at 6MHz.
    play(m, pulseTrain(tape, 1500, 3_000_000), 0x08);
    expect(Array.from(m.services.tape!.recordedBytes!()!.data)).toEqual(Array.from(expected));
  });

  it('records nothing while the motor is off (port 0x84 is the sound DAC then)', () => {
    const m = machine('lynx48');
    play(m, pulseTrain(tape, 2000, 4_000_000), 0x00);
    expect(m.services.tape!.recordedBytes!()).toBeNull();
  });

  it('is cleared by a reset', () => {
    const m = machine('lynx48');
    play(m, pulseTrain(tape, 2000, 4_000_000), 0x02);
    m.reset();
    expect(m.services.tape!.recordedBytes!()).toBeNull();
  });
});

describe('decodeLynxSavePulses', () => {
  it('needs the A5 sync byte after the leader', () => {
    // Leader then 0x5A instead of 0xA5: not a block.
    const widths: number[] = [];
    for (let i = 0; i < 2000; i++) widths.push(2000);
    for (const byte of [0x5a, 0x42, 0x00]) {
      for (let bit = 7; bit >= 0; bit--) {
        const w = (byte >> bit) & 1 ? 4000 : 2000;
        widths.push(w, w);
      }
    }
    expect(decodeLynxSavePulses(widths)).toEqual([]);
  });

  it('drops a trailing partial byte', () => {
    const widths = pulseTrain([[0x42, 0x01]], 2000, 4_000_000);
    widths.pop();                                  // the gap
    widths.push(4000, 4000, 2000, 2000);           // two more bits: not a byte
    const blocks = decodeLynxSavePulses(widths);
    expect(blocks.map(b => Array.from(b))).toEqual([[0x42, 0x01]]);
  });

  it('ignores a name block with no data entry after it', () => {
    const blocks = [Uint8Array.from([0x22, 0x41, 0x22])];
    expect(encodeLynxTap(blocks)).toBeNull();
  });

  it('cuts a data block to the size its header gives', () => {
    const entry = basicEntry([1, 2]);
    const block = Uint8Array.from([...entry, 0xee, 0xee]);
    expect(Array.from(encodeLynxTap([block])!)).toEqual(entry);
  });
});

describe('Lynx SAVE recording against zx84\'s own tape playback', () => {
  it('a .tap played through the deck and captured edge by edge decodes to itself', () => {
    const tap = Uint8Array.from([...file('XY', codeEntry([9, 8, 7, 6])).flat()]);
    const clock = 4_000_000;
    const deck = new TapeDeck(clock);
    deck.pulseScale = clock / TAPE_REF_HZ;
    deck.blocks = parseLynxTap(tap, LYNX_TAPE_HZ_48).blocks;
    deck.position = 0;
    deck.paused = false;
    deck.startPlayback();

    const m = machine('lynx48');
    let t = 1000;
    let last = deck.earBit;
    for (let step = 0; step < 4_000_000 && deck.playing; step++) {
      deck.advance(50);
      t += 50;
      if (deck.earBit !== last) {
        last = deck.earBit;
        m.tapeRecorder.observe(last, t);
      }
    }
    m.cpu.tStates = t + 4_000_000;
    expect(Array.from(m.services.tape!.recordedBytes!()!.data)).toEqual(Array.from(tap));
  });
});
