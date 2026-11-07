/**
 * Apple II cassette recording: the $C020 output toggles a program makes come
 * back out of the Save menu as a WAV, and that WAV plays back into $C060 with
 * the same edge spacing.
 *
 * No Monitor ROM is needed (and none is shipped with the tests): a small
 * hand-assembled program toggles $C020 from a table of delays, so every
 * expected half-cycle comes from the 6502's published instruction timings,
 * not from the recorder. The container is checked against the canonical
 * RIFF/WAVE PCM header layout.
 */

import { describe, it, expect } from 'vitest';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';
import { APPLE2_CPU_CLOCK } from '@/machines/apple2/constants.ts';

/** A 12K system ROM that just loops at $D000 (the reset vector's target). */
function idleRom(): Uint8Array {
  const rom = new Uint8Array(0x3000);
  rom.set([0x4C, 0x00, 0xD0], 0x0000);          // JMP $D000
  rom[0x2FFC] = 0x00;
  rom[0x2FFD] = 0xD0;
  return rom;
}

function machine(): Apple2Machine {
  const m = new Apple2Machine('apple2-plus', null);
  m.memory.loadRom(idleRom());
  m.reset();
  return m;
}

/**
 * Two passes over a table of delays at $0400 (0-terminated), toggling $C020
 * once per entry:
 *
 *   0300 A9 02     LDA #2
 *   0302 85 10     STA $10
 *   0304 A2 00     LDX #0
 *   0306 BC 00 04  LDY $0400,X   4
 *   0309 F0 0B     BEQ $0316     2 (not taken)
 *   030B AD 20 C0  LDA $C020     4  <- the toggle
 *   030E 88        DEY           2 \  5k-1 for k
 *   030F D0 FD     BNE $030E     3/2
 *   0311 E8        INX           2
 *   0312 4C 06 03  JMP $0306     3
 *   0315 EA        NOP
 *   0316 C6 10     DEC $10
 *   0318 D0 EA     BNE $0304
 *   031A 4C 1A 03  JMP $031A
 *
 * An iteration is 4+2+4+(5k-1)+2+3 = 5k+14 cycles, and the toggle sits at the
 * same point in each, so the toggle for entry i is followed by the next one
 * 5·k[i] + 14 cycles later. No access crosses a page.
 */
const PROGRAM = [
  0xA9, 0x02, 0x85, 0x10, 0xA2, 0x00, 0xBC, 0x00, 0x04, 0xF0, 0x0B, 0xAD, 0x20, 0xC0,
  0x88, 0xD0, 0xFD, 0xE8, 0x4C, 0x06, 0x03, 0xEA, 0xC6, 0x10, 0xD0, 0xEA, 0x4C, 0x1A, 0x03,
];

/** 100 long "leader" half-cycles (5·128+14 = 654 cycles, ~770 Hz like the
 *  Monitor's header tone), then 150 of the two bit widths: 5·48+14 = 254
 *  cycles (~2 kHz, a 0) and 5·99+14 = 509 cycles (~1 kHz, a 1), in pairs. */
function delays(): number[] {
  const k: number[] = [];
  for (let i = 0; i < 100; i++) k.push(128);
  for (let i = 0; i < 75; i++) { const w = (i * 7) % 3 === 0 ? 99 : 48; k.push(w, w); }
  return k;
}

/** Run the toggle program to completion. */
function save(m: Apple2Machine, k: readonly number[]): void {
  m.memory.ram.set(PROGRAM, 0x300);
  m.memory.ram.set([...k, 0], 0x400);
  m.cpu.pc = 0x300;
  for (let f = 0; f < 40 && m.cpu.pc !== 0x31A; f++) m.tick();
  expect(m.cpu.pc).toBe(0x31A);
}

const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint16(o, true);
const tag = (b: Uint8Array, o: number) => String.fromCharCode(...b.subarray(o, o + 4));

describe('apple2 cassette recording', () => {
  it('has nothing to offer before anything is written', () => {
    const m = machine();
    try {
      expect(m.services.tape.recordedBytes()).toBeNull();
      m.memory.readByte(0xC020);                 // a stray click is not a recording
      m.memory.writeByte(0xC020, 0);
      expect(m.services.tape.recordedBytes()).toBeNull();
    } finally { m.destroy(); }
  });

  it('writes a canonical 16-bit mono PCM WAV header', () => {
    const m = machine();
    try {
      save(m, delays());
      const rec = m.services.tape.recordedBytes()!;
      expect(rec.filename).toBe('apple2-tape.wav');
      const b = rec.data;
      expect(tag(b, 0)).toBe('RIFF');
      expect(u32(b, 4)).toBe(b.length - 8);      // RIFF size covers the rest of the file
      expect(tag(b, 8)).toBe('WAVE');
      expect(tag(b, 12)).toBe('fmt ');
      expect(u32(b, 16)).toBe(16);               // PCM fmt chunk
      expect(u16(b, 20)).toBe(1);                // WAVE_FORMAT_PCM
      expect(u16(b, 22)).toBe(1);                // mono
      expect(u32(b, 24)).toBe(44100);
      expect(u32(b, 28)).toBe(88200);            // byte rate = 44100 × 2
      expect(u16(b, 32)).toBe(2);                // block align
      expect(u16(b, 34)).toBe(16);
      expect(tag(b, 36)).toBe('data');
      expect(u32(b, 40)).toBe(b.length - 44);
    } finally { m.destroy(); }
  });

  it('plays its recording back into $C060 with the program\'s own edge spacing', async () => {
    const k = delays();
    const m = machine();
    let wav: Uint8Array;
    try {
      save(m, k);
      wav = m.services.tape.recordedBytes()!.data;
    } finally { m.destroy(); }

    // Load it on a fresh machine through the tape service and watch the input.
    const p = machine();
    try {
      expect(await p.services.tape.mountBytes(wav, 'apple2-tape.wav')).toBe(true);
      p.services.tape.play();
      const flips: number[] = [];
      let level = p.cassetteInputBit;
      const end = p.cpu.tStates + Math.ceil(APPLE2_CPU_CLOCK * 0.6);
      for (; p.cpu.tStates < end; p.cpu.tStates += 5) {
        const now = p.cassetteInputBit;
        if (now !== level) { flips.push(p.cpu.tStates); level = now; }
      }
      // One flip per toggle the program made: two passes of the table.
      expect(flips.length).toBe(k.length * 2);
      // One output sample is 1022727/44100 ≈ 23.2 cycles; each edge is placed
      // on the nearest sample and read back on a 5-cycle step.
      const tolerance = 30;
      for (const pass of [0, k.length]) {
        for (let i = 0; i < k.length - 1; i++) {
          const spacing = flips[pass + i + 1] - flips[pass + i];
          expect(Math.abs(spacing - (5 * k[i] + 14)), `pass ${pass ? 2 : 1} edge ${i}`)
            .toBeLessThanOrEqual(tolerance);
        }
      }
    } finally { p.destroy(); }
  });

  it('times each toggle on the cycle the access happens, not the instruction start', () => {
    // LDA $C020 starts at t and reads on its 4th cycle (t+3). LDY #0 runs
    // t+4..t+5. LDA ($10),Y with no page cross starts at t+6 and reads on its
    // 5th cycle (t+10). So the edges are 7 cycles apart (instruction starts: 6).
    const m = machine();
    try {
      m.memory.ram.set([0x20, 0xC0], 0x10);      // ($10) -> $C020
      // 0300 AD 20 C0  LDA $C020 / 0303 A0 00  LDY #0 / 0305 B1 10  LDA ($10),Y / 0307 4C 07 03  JMP $0307
      m.memory.ram.set([0xAD, 0x20, 0xC0, 0xA0, 0x00, 0xB1, 0x10, 0x4C, 0x07, 0x03], 0x300);
      m.cpu.pc = 0x300;
      m.tick();
      expect(m.cpu.pc).toBe(0x307);
      expect([...m.tapeRecorder.pulses()]).toEqual([7]);
    } finally { m.destroy(); }
  });

  it('forgets the recording on reset', () => {
    const m = machine();
    try {
      save(m, delays());
      expect(m.services.tape.recordedBytes()).not.toBeNull();
      m.reset();
      expect(m.services.tape.recordedBytes()).toBeNull();
    } finally { m.destroy(); }
  });
});
