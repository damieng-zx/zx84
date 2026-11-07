/**
 * The ZX80/ZX81 cassette as a signal: the documented pulse encoding, TZX
 * block 0x19 and WAVE input, and the EAR bit on port 0xFE reads that the real
 * ROM's LOAD and custom loaders read it through.
 *
 * Expected values come from the ZX81 manual's cassette chapter and the TZX
 * specification's ZX81 symbols, not from running the encoder: a bit is a
 * burst of 4 (zero) or 9 (one) pulses of about 150us with high/low halves of
 * 530T/520T at the TZX reference clock of 3.5MHz, followed by a gap of
 * 4689T (1.34ms); bytes go MSB first; a file is the name (last character
 * with bit 7 set) and the RAM image from VERSN up to E_LINE.
 *
 * The real-ROM cases need zx81-v2.rom (see rom-harness.ts) and skip without.
 */

import { describe, it, expect } from 'vitest';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import {
  asciiToZx81Name, decodeZx8xPulses, encodeZx8xBytes, parseZx8xTapeFile, zx8xProgramBlocks,
} from '@/machines/zx8x/tape-signal.ts';
import { zx8xTapeBlocks } from '@/machines/zx8x/services/tape.ts';
import {
  boot, enterPrint42, haveZx81Rom, QUOTE, ram, runUntil, screen, type, word,
} from './rom-harness.ts';

const HZ = 3_500_000;

/** A minimal ZX81 program image: VERSN to E_LINE, with E_LINE ($4014) the
 *  address just past the image. */
function image(length: number): Uint8Array {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) data[i] = (i * 37 + 5) & 0xff;
  const eLine = 0x4009 + length;
  data[0x4014 - 0x4009] = eLine & 0xff;
  data[0x4014 - 0x4009 + 1] = eLine >> 8;
  return data;
}

/** A TZX holding `bytes` as one ZX81 generalized data block (0x19): two data
 *  symbols, each starting by forcing the line high, the TZX spec's layout. */
function zx81Tzx(bytes: Uint8Array, pauseMs = 1000): Uint8Array {
  const symbol = (flag: number, pulses: number[]): number[] => {
    const out = [flag];
    for (let i = 0; i < 18; i++) {
      const p = pulses[i] ?? 0;
      out.push(p & 0xff, p >> 8);
    }
    return out;
  };
  const bit0 = [530, 520, 530, 520, 530, 520, 530, 4689];
  const bit1 = [530, 520, 530, 520, 530, 520, 530, 520, 530, 520, 530, 520, 530, 520, 530, 520, 530, 4689];
  const totd = bytes.length * 8;
  const body: number[] = [
    pauseMs & 0xff, pauseMs >> 8,
    0, 0, 0, 0, 0, 0,                                   // TOTP = 0, NPP = 0, ASP = 0
    totd & 0xff, (totd >> 8) & 0xff, (totd >> 16) & 0xff, 0,
    18, 2,                                              // NPD = 18, ASD = 2
    ...symbol(3, bit0), ...symbol(3, bit1),
  ];
  body.push(...bytes);                                  // one bit per symbol: the bytes themselves
  const header = [0x5a, 0x58, 0x54, 0x61, 0x70, 0x65, 0x21, 0x1a, 1, 20];
  const len = body.length;
  return Uint8Array.from([...header, 0x19, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, 0, ...body]);
}

/** Render pulse runs (3.5MHz T) as a 44.1kHz mono 8-bit WAVE; `level` is the
 *  line's level during the first run. */
function wave(runs: ArrayLike<number>, level: number, rate = 44100): Uint8Array {
  const samples: number[] = [];
  let carry = 0;
  for (let i = 0; i < runs.length; i++) {
    const exact = runs[i] * rate / HZ + carry;
    const n = Math.round(exact);
    carry = exact - n;
    for (let s = 0; s < n; s++) samples.push(level ? 0xe0 : 0x20);
    level ^= 1;
  }
  const out = new Uint8Array(44 + samples.length);
  const v = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46]); v.setUint32(4, 36 + samples.length, true);
  out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36); v.setUint32(40, samples.length, true);
  out.set(samples, 44);
  return out;
}

describe('ZX80/ZX81 pulse encoding', () => {
  it('writes a one as 9 pulses and a zero as 4, each bit ended by a 4689T gap', () => {
    // 0x80: a one, then seven zeros. Runs after the 1 lead: bit 1 is 9 highs
    // and 8 lows; each later bit is the gap then 4 highs and 3 lows.
    const runs = encodeZx8xBytes(Uint8Array.of(0x80), 1000);
    expect(runs[0]).toBe(1000);                              // the lead silence
    expect(runs.length).toBe(1 + (9 + 8) + 7 * (1 + 4 + 3));
    const one = Array.from(runs.subarray(1, 18));
    expect(one.filter((_, i) => i % 2 === 0)).toEqual(new Array(9).fill(530));
    expect(one.filter((_, i) => i % 2 === 1)).toEqual(new Array(8).fill(520));
    expect(runs[18]).toBe(4689);
    // The next bit is a zero: four pulses, then the next gap.
    expect(Array.from(runs.subarray(19, 26))).toEqual([530, 520, 530, 520, 530, 520, 530]);
    expect(runs[26]).toBe(4689);
    // A pulse is about 150us: 530T and 520T at 3.5MHz are 151us and 149us.
    expect(Math.round(530 / HZ * 1e6)).toBe(151);
  });

  it('sends bytes most significant bit first', () => {
    // 0x01 is seven zeros then a one: only the last burst is 9 pulses long.
    const runs = Array.from(encodeZx8xBytes(Uint8Array.of(0x01), 0)).slice(1);
    const bursts: number[] = [];
    let n = 0;
    for (const r of runs) {
      if (r === 4689) { bursts.push((n + 1) >> 1); n = 0; } else n++;
    }
    bursts.push((n + 1) >> 1);
    expect(bursts).toEqual([4, 4, 4, 4, 4, 4, 4, 9]);
  });

  it('decodes a ZX81 file back to its name and an image ending at E_LINE', () => {
    const data = image(40);
    const name = asciiToZx81Name('MAZE 2');
    const bytes = new Uint8Array(name.length + data.length);
    bytes.set(name); bytes.set(data, name.length);
    const runs = encodeZx8xBytes(bytes);
    const found = decodeZx8xPulses('zx81', runs, 1);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('MAZE 2');
    expect(Array.from(found[0].data)).toEqual(Array.from(data));
  });

  it('decodes a ZX80 file (no name, image from $4000 to E_LINE at $400A)', () => {
    const data = new Uint8Array(30);
    data[0x0a] = 0x1e; data[0x0b] = 0x40;                    // E_LINE = $401E
    data[3] = 0x77;
    const found = decodeZx8xPulses('zx80', encodeZx8xBytes(data), 1);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('');
    expect(Array.from(found[0].data)).toEqual(Array.from(data));
  });

  it('finds two programs recorded one after another and ignores a cut-short one', () => {
    const a = image(24);
    const b = image(18);
    const nameA = asciiToZx81Name('A');
    const nameB = asciiToZx81Name('B');
    const cat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap(p => Array.from(p)));
    const gap = Uint32Array.of(HZ / 2);
    const runs = Uint32Array.from([
      ...encodeZx8xBytes(cat(nameA, a)), ...gap,
      ...encodeZx8xBytes(cat(nameB, b.subarray(0, 10)), 0), ...gap,   // cut short
      ...encodeZx8xBytes(cat(nameB, b), 0),
    ]);
    const found = decodeZx8xPulses('zx81', runs, 1);
    expect(found.map(p => p.name)).toEqual(['A', 'B']);
    expect(found[1].data.length).toBe(18);
  });

  it('rejects a file whose E_LINE lies outside the bytes it carries', () => {
    const data = image(20);
    data[0x4014 - 0x4009] = 0xff;                             // E_LINE = $41FF: beyond the end
    data[0x4014 - 0x4009 + 1] = 0x41;
    expect(parseZx8xTapeFile('zx81', Uint8Array.from([...asciiToZx81Name('X'), ...data]))).toBeNull();
  });
});

describe('ZX81 tapes as files', () => {
  it('reads the programs from a TZX generalized data block (0x19)', async () => {
    const data = image(60);
    const name = asciiToZx81Name('GAME');
    const m = new Zx8xMachine('zx81');
    m.loadROM(new Uint8Array(0x2000));
    const result = await m.services.media.mount(zx81Tzx(Uint8Array.from([...name, ...data])), 'game.tzx');
    expect(result.ok).toBe(true);
    expect(m.cassette.programs.map(p => [p.name, p.data.length])).toEqual([['GAME', 60]]);
    expect(Array.from(m.cassette.programs[0].data)).toEqual(Array.from(data));
    // The pane lists it as a LOAD line.
    expect(m.services.tape.blocks.some(b => b.label === 'LOAD "GAME"')).toBe(true);
  });

  it('reads a WAVE recording of either polarity', () => {
    const data = image(34);
    const bytes = Uint8Array.from([...asciiToZx81Name('TONE'), ...data]);
    const runs = encodeZx8xBytes(bytes);
    for (const level of [0, 1]) {
      const m = new Zx8xMachine('zx81');
      m.loadROM(new Uint8Array(0x2000));
      const blocks = zx8xTapeBlocks('zx81', wave(runs, level), 'tone.wav').blocks;
      m.cassette.mount(blocks, 'tone.wav');
      expect(m.cassette.programs.map(p => p.name)).toEqual(['TONE']);
      expect(Array.from(m.cassette.programs[0].data)).toEqual(Array.from(data));
    }
  });

  it('turns a .p image into pulses that carry its name and bytes', () => {
    const data = image(30);
    const { blocks, program } = zx8xTapeBlocks('zx81', data, 'Pulse Me.p');
    expect(program?.name).toBe('PULSE ME');
    const found = decodeZx8xPulses('zx81', (blocks[1] as { pulses: Uint32Array }).pulses, 1);
    expect(found[0].name).toBe('PULSE ME');
    expect(Array.from(found[0].data)).toEqual(Array.from(data));
    expect(zx8xProgramBlocks('zx80', null, new Uint8Array(12))[0]).toEqual({ kind: 'set-level', level: 0 });
  });
});

describe('the EAR bit on port 0xFE', () => {
  /** Count the pulses of the first burst the tape plays, from machine code
   *  that reads bit 7 of port 0xFE in a tight loop and halts when the line
   *  has been low for longer than a pulse gap. */
  function pulsesInFirstBurst(byte: number): number {
    const m = new Zx8xMachine('zx81');
    m.loadROM(new Uint8Array(0x2000));
    m.reset();
    const code = [
      0x16, 0x00,             // 4100 LD D,0
      0xdb, 0xfe,             // 4102 w1: IN A,(FE)
      0x17,                   //      RLA            carry = bit 7
      0x30, 0xfb,            //      JR NC,w1
      0x14,                   // 4107 high: INC D
      0xdb, 0xfe,             // 4108 w2: IN A,(FE)
      0x17,                   //      RLA
      0x38, 0xfb,            //      JR C,w2
      0x06, 0x3c,             // 410D LD B,60
      0xdb, 0xfe,             // 410F w3: IN A,(FE)
      0x17,                   //      RLA
      0x38, 0xf3,            //      JR C,high
      0x10, 0xf9,            //      DJNZ w3
      0x76,                   // 4116 HALT: nothing for 60 reads
    ];
    code.forEach((b, i) => m.memory.writeByte(0x4100 + i, b));
    m.cpu.pc = 0x4100;
    m.cpu.sp = 0x43f0;
    m.cpu.iff1 = false;
    const blocks = [
      { kind: 'set-level', level: 0 } as const,
      { kind: 'csw', pulses: encodeZx8xBytes(Uint8Array.of(byte)) } as const,
    ];
    m.cassette.mount([...blocks], 'burst');
    m.playTape();
    runUntil(m, () => m.cpu.halted, 200);
    return m.cpu.d;
  }

  it('lets a loader that bypasses the ROM count a one as 9 pulses and a zero as 4', () => {
    expect(pulsesInFirstBurst(0xff)).toBe(9);
    expect(pulsesInFirstBurst(0x00)).toBe(4);
  });

  it('does not touch the keyboard bits or any other port', () => {
    const m = new Zx8xMachine('zx81');
    m.loadROM(new Uint8Array(0x2000));
    // Nothing playing: bit 7 stays clear, the keyboard idles at 0x60 | 0x1f.
    expect(m.cpu.portInHandler!(0x00fe)).toBe(0x7f);
  });
});

describe.skipIf(!haveZx81Rom)('cassette through the real ZX81 ROM (skipped without zx81-v2.rom)', () => {
  const realTime = { 'tape-instant-rom': false };

  it('SAVE writes pulses on the MIC line that decode to the saved image', () => {
    const m = boot(realTime);
    enterPrint42(m);
    expect(m.services.tape.recordedBytes()).toBeNull();
    const program = ram(m, 0x407d, word(m, 0x400c));         // BASIC: $407D up to D_FILE
    type(m, ['KeyS', QUOTE, 'KeyA', 'KeyB', QUOTE, 'Enter']);
    runUntil(m, () => m.services.tape.recordedBytes() !== null, 3000);
    const rec = m.services.tape.recordedBytes();
    expect(rec).not.toBeNull();
    expect(rec!.filename).toBe('AB.p');
    const data = rec!.data;
    // The image is VERSN up to E_LINE and carries E_LINE itself.
    expect(0x4009 + data.length).toBe(data[0x4014 - 0x4009] | (data[0x4015 - 0x4009] << 8));
    const dfile = data[0x400c - 0x4009] | (data[0x400d - 0x4009] << 8);
    expect(Array.from(data.subarray(0x407d - 0x4009, dfile - 0x4009))).toEqual(program);
  });

  it('the real LOAD reads a .p image played as pulses with the instant trap off', async () => {
    const saver = boot(realTime);
    enterPrint42(saver);
    const program = ram(saver, 0x407d, word(saver, 0x400c));
    type(saver, ['KeyS', QUOTE, 'KeyA', 'KeyB', QUOTE, 'Enter']);
    runUntil(saver, () => saver.services.tape.recordedBytes() !== null, 3000);
    const rec = saver.services.tape.recordedBytes()!;

    const m = boot(realTime);
    type(m, ['KeyJ', QUOTE, QUOTE, 'Enter']);                 // LOAD ""
    expect(m.awaitingTapeLoad).toBe(true);
    const mounted = await m.services.media.mount(rec.data, rec.filename);
    expect(mounted.ok).toBe(true);
    // Real time: the ROM reads the deck, nothing is copied into RAM at once.
    expect(ram(m, 0x407d, 0x407d + 4)).not.toEqual(program.slice(0, 4));
    runUntil(m, () => m.cassette.deck.finished, 2000);
    for (let f = 0; f < 60; f++) m.tick();
    expect(ram(m, 0x407d, word(m, 0x400c))).toEqual(program);
    type(m, ['KeyR', 'Enter']);                               // RUN
    expect(screen(m)).toMatch(/^42/);
  });

  it('LOAD "NAME" skips the other programs on a tape and takes the one it asks for', async () => {
    const make = (name: string, line: string[]): Uint8Array => {
      const m = boot(realTime);
      type(m, line);
      type(m, ['KeyS', QUOTE, ...name.split('').map(c => `Key${c}`), QUOTE, 'Enter']);
      runUntil(m, () => m.services.tape.recordedBytes() !== null, 3000);
      return m.services.tape.recordedBytes()!.data;
    };
    const first = make('AA', ['Digit1', 'Digit0', 'KeyP', 'Digit4', 'Enter']);    // 10 PRINT 4
    const second = make('BB', ['Digit2', 'Digit0', 'KeyP', 'Digit7', 'Enter']);   // 20 PRINT 7
    const bytes = (name: string, data: Uint8Array): number[] => [...asciiToZx81Name(name), ...data];
    const runs = Uint32Array.from([
      ...encodeZx8xBytes(Uint8Array.from(bytes('AA', first))),
      ...encodeZx8xBytes(Uint8Array.from(bytes('BB', second)), HZ / 4),
    ]);
    const m = boot(realTime);
    type(m, ['KeyJ', QUOTE, 'KeyB', 'KeyB', QUOTE, 'Enter']);  // LOAD "BB"
    const tape = zx8xTapeBlocks('zx81', wave(runs, 1), 'two.wav');
    m.cassette.mount(tape.blocks, 'two.wav');
    expect(m.cassette.programs.map(p => p.name)).toEqual(['AA', 'BB']);
    m.playTape();
    runUntil(m, () => m.cassette.deck.finished, 4000);
    for (let f = 0; f < 60; f++) m.tick();
    // The first BASIC line's number is big-endian at $407D: line 20 is BB's.
    expect(m.memory.readByte(0x407e)).toBe(20);
  });

  it('plays a WAVE of what SAVE wrote (either polarity) into a fresh machine\'s LOAD', async () => {
    const saver = boot(realTime);
    enterPrint42(saver);
    const program = ram(saver, 0x407d, word(saver, 0x400c));
    type(saver, ['KeyS', QUOTE, 'KeyA', QUOTE, 'Enter']);
    runUntil(saver, () => saver.services.tape.recordedBytes() !== null, 3000);
    const pulses = saver.micRecorder.pulses(saver.cpu.tStates);
    const first = saver.micRecorder.firstLevel;
    const scale = HZ / 3_250_000;
    const runs = Array.from(pulses, p => Math.round(p * scale));
    for (const level of [first, first ^ 1]) {
      const m = boot(realTime);
      type(m, ['KeyJ', QUOTE, QUOTE, 'Enter']);
      const mounted = await m.services.media.mount(wave(runs, level), 'save.wav');
      expect(mounted.ok).toBe(true);
      runUntil(m, () => m.cassette.deck.finished, 3000);
      for (let f = 0; f < 60; f++) m.tick();
      expect(ram(m, 0x407d, word(m, 0x400c))).toEqual(program);
    }
  });

  it('records the same program image with the trap on and off', () => {
    const saved = (fast: boolean): Uint8Array => {
      const m = boot({ 'tape-instant-rom': fast });
      enterPrint42(m);
      type(m, ['KeyS', QUOTE, 'KeyA', 'KeyB', QUOTE, 'Enter']);
      runUntil(m, () => m.services.tape.recordedBytes() !== null, 3000);
      return m.services.tape.recordedBytes()!.data;
    };
    const fast = saved(true);
    const real = saved(false);
    expect(real.length).toBe(fast.length);
    // Everything but FRAMES-style counters the two runs may differ on.
    const sameFrom = 0x407d - 0x4009;
    expect(Array.from(real.subarray(sameFrom))).toEqual(Array.from(fast.subarray(sameFrom)));
  });
});
