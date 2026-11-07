/**
 * The Datasette on the VIC-20, and the .tap format's clocks.
 *
 * From the hardware: the cassette sense switch is VIA 1 PA6 (low while a
 * button is down), the motor VIA 1 CA2 (on while held low: PCR bits 1-3 =
 * 110), the read line VIA 2 CA1 and the write line VIA 2 PB3. From the .tap
 * format: byte 13 is the platform (0 C64, 1 VIC-20) and byte 14 the video
 * standard (0 PAL, 1 NTSC), and each data byte counts 8 cycles of that
 * machine's clock (PAL VIC-20 1,108,405 Hz, NTSC 1,022,727 Hz; PAL C64
 * 985,248 Hz).
 */

import { describe, it, expect } from 'vitest';
import {
  encodeC64Tap, encodeKernalTap, parseC64Tap, readC64TapPulses, tapClock, tapFormat,
} from '@/media/tape/c64-tap.ts';
import { firmware, machine } from './firmware.ts';

/** A .tap with the given header bytes and data. */
function tap(platform: number, video: number, body: number[]): Uint8Array {
  const out = new Uint8Array(20 + body.length);
  'C64-TAPE-RAW'.split('').forEach((c, i) => { out[i] = c.charCodeAt(0); });
  out[12] = 1; out[13] = platform; out[14] = video;
  out[16] = body.length & 0xFF; out[17] = body.length >> 8;
  out.set(body, 20);
  return out;
}

describe('.tap clocks', () => {
  it('counts each platform and standard in its own clock', () => {
    expect(tapClock(0, 0)).toBe(985_248);
    expect(tapClock(0, 1)).toBe(1_022_727);
    expect(tapClock(1, 0)).toBe(1_108_405);
    expect(tapClock(1, 1)).toBe(1_022_727);
    expect(readC64TapPulses(tap(1, 0, [0x30])).clock).toBe(1_108_405);
  });

  it('writes the machine into the header', () => {
    const file = encodeC64Tap([800, 1600], tapFormat(1, 0));
    expect(file[13]).toBe(1);
    expect(file[14]).toBe(0);
    expect(Array.from(readC64TapPulses(file).pulses)).toEqual([800, 1600]);
  });

  it('tapes a program as the KERNAL would, in VIC-20 cycles, and reads its header back', () => {
    const format = tapFormat(1, 0);
    const file = encodeKernalTap([{ name: 'game', start: 0x1001, data: Uint8Array.from([1, 2, 3]) }], format, [0x1001]);
    expect(file[13]).toBe(1);
    // A program at the start of BASIC is relocatable (type 1).
    expect(parseC64Tap(file).files[0]).toEqual({ type: 1, name: 'GAME', start: 0x1001, end: 0x1004 });
    // The VIC-20 KERNAL's short pulse: TAP byte $2C, 352 VIC-20 cycles.
    const shortest = Math.min(...readC64TapPulses(file).pulses);
    expect(shortest).toBe(0x2C * 8);
  });

  it('plays a VIC-20 pulse for as long as it lasted on the VIC-20', () => {
    // The same byte is a longer time at the C64's slower clock.
    const vic = parseC64Tap(tap(1, 0, [0x40, 0x40])).blocks[0];
    const c64 = parseC64Tap(tap(0, 0, [0x40, 0x40])).blocks[0];
    const len = (b: typeof vic) => ('pulses' in b ? (b.pulses as Uint32Array)[0] + (b.pulses as Uint32Array)[1] : 0);
    expect(len(vic) / len(c64)).toBeCloseTo(985_248 / 1_108_405, 2);
  });
});

describe('VIC-20 Datasette wiring', () => {
  it('senses a button down on an empty deck (RECORD and PLAY), and up on a mounted tape', async () => {
    const m = machine(firmware());
    m.memory.writeByte(0x9113, 0x00);
    expect(m.memory.readByte(0x9111) & 0x40, 'empty deck: PA6 low').toBe(0);
    const ok = m.services.tape.mount(tap(1, 0, new Array(200).fill(0x30)), 'x.tap');
    expect(ok).toBe(true);
    expect(m.memory.readByte(0x9111) & 0x40, 'tape mounted, PLAY up').toBe(0x40);
    m.services.tape.play();
    expect(m.memory.readByte(0x9111) & 0x40, 'PLAY down').toBe(0);
    m.destroy();
  });

  it('runs the motor while VIA 1 holds CA2 low', () => {
    const m = machine(firmware());
    m.memory.writeByte(0x911C, 0x0C);                 // CA2 low output
    expect(m.motorOn).toBe(true);
    m.memory.writeByte(0x911C, 0x0E);                 // CA2 high output
    expect(m.motorOn).toBe(false);
    m.destroy();
  });

  it('moves the tape only with the motor on, and edges reach VIA 2 CA1', () => {
    const m = machine(firmware());
    m.services.tape.mount(tap(1, 0, new Array(2000).fill(0x30)), 'x.tap');
    m.services.tape.play();
    m.memory.writeByte(0x911C, 0x0E);                 // motor off
    m.tick();
    expect(m.activity.tapeEdges).toBe(0);
    m.memory.writeByte(0x911C, 0x0C);                 // motor on
    m.memory.writeByte(0x912C, 0x00);                 // CA1 on the falling edge
    m.tick();
    // A frame is 22,152 cycles; a pulse 0x30 × 8 = 384: about 57 of them.
    expect(m.activity.tapeEdges).toBeGreaterThanOrEqual(55);
    expect(m.activity.tapeEdges).toBeLessThanOrEqual(59);
    expect(m.via2.ifr & 0x02, 'CA1 flagged').toBe(0x02);
    m.destroy();
  });

  it('records the write line (PB3) while the motor runs, as a VIC-20 .tap', () => {
    const m = machine(firmware());
    m.memory.writeByte(0x9122, 0x08);                 // PB3 an output
    m.memory.writeByte(0x911C, 0x0C);                 // motor on
    for (let i = 0; i < 40; i++) {
      m.memory.writeByte(0x9120, (i & 1) !== 0 ? 0x08 : 0x00);
      m.cpu.tStates += 200;
    }
    expect(m.tapeRecorder.count).toBeGreaterThan(30);
    const saved = m.services.tape.recordedBytes();
    expect(saved).not.toBeNull();
    expect(saved!.data[13], 'platform: VIC-20').toBe(1);
    expect(saved!.filename).toMatch(/\.tap$/);
    m.destroy();
  });

  it('presses PLAY when a program sits polling the sense line', () => {
    const m = machine(firmware());
    m.services.tape.mount(tap(1, 0, new Array(200).fill(0x30)), 'x.tap');
    expect(m.tape.playing).toBe(false);
    for (let i = 0; i < 150; i++) m.memory.readByte(0x911F);
    m.tick();
    expect(m.tape.playing).toBe(true);
    m.destroy();
  });

  it('puts a dropped .prg on the tape as well', async () => {
    const m = machine(firmware(0x1001));
    const r = await m.services.media.mount(Uint8Array.from([0x01, 0x10, 0xAA, 0xBB]), 'demo.prg');
    expect(r.ok).toBe(true);
    expect(m.services.tape.loaded).toBe(true);
    expect(m.services.tape.files[0]?.name).toBe('DEMO');
    m.destroy();
  });
});
