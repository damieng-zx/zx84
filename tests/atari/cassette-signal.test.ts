/**
 * Atari program recorder at signal level: the tape on a time line, POKEY's
 * serial input, and loaders that read the recorder themselves.
 *
 * Expectations:
 *  - a record plays as its bytes framed 8N1 at the record's baud rate (a 0
 *    start bit, eight data bits LSB first, a 1 stop bit) after its gap of
 *    mark tone; an `fsk ` block is 0.1 ms durations of alternating space and
 *    mark, space first (the .cas format);
 *  - the tape only moves while the motor line is on, and records the tape
 *    has run past are gone;
 *  - POKEY: SKSTAT bit 4 is the data-in line; the receiver is clocked by
 *    channel 4 (SKCTL bits 4-6 = 1-3, 6, 7), one bit per two channel-4
 *    periods; AUDCTL $28 joins channels 3+4 with channel 3 at 1.79 MHz, a
 *    period of AUDF4:AUDF3 + 7 cycles; the OS reads 600 baud tape with
 *    AUDF3/AUDF4 = $CC/$05 (1491 cycles, 2982 per bit at 1.79 MHz). A
 *    received byte lands in SERIN and pulls IRQST bit 5 low; SKSTAT bit 7
 *    goes low on a framing error, bit 5 on an overrun, bit 1 while a byte
 *    is shifting in; SKRES clears the latches;
 *  - real-ROM case: with the SIO fast path off, the OS's own cassette
 *    routine loads a CSAVEd program bit by bit through POKEY.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { AtariCassette } from '@/machines/atari/cassette.ts';
import { Pokey } from '@/machines/atari/pokey.ts';
import {
  CAS_EOF, CAS_FULL, isFskBlock, parseAtariCas, sioChecksum, writeAtariCas,
} from '@/media/tape/atari-cas.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

// ── Tape helpers ───────────────────────────────────────────────────────────

/** A standard record: $55 $55, control byte, 128 data bytes, checksum. */
function record(control: number, data: (i: number) => number): Uint8Array {
  const out = new Uint8Array(132);
  out.set([0x55, 0x55, control]);
  for (let i = 0; i < 128; i++) out[3 + i] = data(i) & 0xff;
  out[131] = sioChecksum(out, 131);
  return out;
}

function chunk(id: string, aux: number, payload: Uint8Array | number[] = []): number[] {
  const p = [...payload];
  return [...id].map(c => c.charCodeAt(0)).concat([p.length & 0xff, p.length >> 8, aux & 0xff, aux >> 8], p);
}

/** A .cas image built from chunks. */
function casOf(...chunks: number[][]): Uint8Array {
  return new Uint8Array([...chunk('FUJI', 0), ...chunks.flat()]);
}

/** A 600 kHz clock keeps the arithmetic plain: a 600-baud bit is 1000
 *  cycles and a millisecond 600. */
const CLOCK = 600_000;
const BIT = 1000;
const MS = 600;

describe('atari .cas fsk chunks', () => {
  it('parses an fsk chunk into its durations and gap, in tape order', () => {
    const image = parseAtariCas(casOf(
      chunk('baud', 600),
      chunk('data', 100, [1, 2, 3]),
      chunk('fsk ', 250, [10, 0, 0x2c, 0x01, 5, 0]),
      chunk('pwms', 0, [1]),
    ))!;
    expect(image.records).toHaveLength(1);
    expect(image.blocks).toHaveLength(2);
    const fsk = image.blocks[1];
    expect(isFskBlock(fsk)).toBe(true);
    if (!isFskBlock(fsk)) return;
    expect([...fsk.fsk]).toEqual([10, 300, 5]);
    expect(fsk.gapMs).toBe(250);
    expect(image.unsupportedChunks).toBe(1);
  });
});

describe('atari cassette signal', () => {
  it('plays a gap of mark, then each byte 8N1 at the record baud rate', () => {
    const tape = new AtariCassette(CLOCK);
    tape.mount(casOf(chunk('baud', 600), chunk('data', 10, [0xa5, 0x01])), 'a.cas');
    const levelAt = (cycles: number) => {
      tape.rewind();
      tape.advance(cycles);
      return tape.level();
    };
    const start = 10 * MS;
    expect(levelAt(start - 1)).toBe(1); // still in the gap
    // $A5 = 1010 0101, sent LSB first: 1 0 1 0 0 1 0 1.
    const frame = [0, 1, 0, 1, 0, 0, 1, 0, 1, 1];
    for (let b = 0; b < 10; b++) expect(levelAt(start + b * BIT + BIT / 2)).toBe(frame[b]);
    // $01: start, 1, seven 0s, stop.
    const second = [0, 1, 0, 0, 0, 0, 0, 0, 0, 1];
    for (let b = 0; b < 10; b++) expect(levelAt(start + (10 + b) * BIT + BIT / 2)).toBe(second[b]);
    expect(levelAt(start + 20 * BIT + 1)).toBe(1); // past the end: idle mark
  });

  it('honours a baud chunk', () => {
    const tape = new AtariCassette(CLOCK);
    tape.mount(casOf(chunk('baud', 1200), chunk('data', 0, [0x00])), 'b.cas');
    // At 1200 baud a bit is 500 cycles: the stop bit is at 4500-5000.
    tape.advance(4600);
    expect(tape.level()).toBe(1);
    tape.rewind();
    tape.advance(4400);
    expect(tape.level()).toBe(0);
  });

  it('plays an fsk block as alternating space and mark, space first', () => {
    const tape = new AtariCassette(CLOCK);
    // Gap 1 ms, then 0.5 ms space, 1 ms mark, 0.2 ms space.
    tape.mount(casOf(chunk('fsk ', 1, [5, 0, 10, 0, 2, 0])), 'f.cas');
    const at = (ms: number) => { tape.rewind(); tape.advance(ms * MS); return tape.level(); };
    expect(at(0.9)).toBe(1);
    expect(at(1.2)).toBe(0);
    expect(at(1.6)).toBe(1);
    expect(at(2.4)).toBe(1);
    expect(at(2.6)).toBe(0);
    expect(at(2.8)).toBe(1); // after the block
  });

  it('hands SIO the next record the tape reaches and moves the tape past it', () => {
    const r0 = record(CAS_FULL, i => i);
    const r1 = record(CAS_EOF, () => 0);
    const tape = new AtariCassette(CLOCK);
    tape.mount(casOf(chunk('baud', 600), chunk('data', 100, [...r0]), chunk('data', 250, [...r1])), 'c.cas');
    expect(tape.readRecord()).toEqual(r0);
    // The tape is now at the end of record 0: the next level is the gap.
    expect(tape.level()).toBe(1);
    expect(tape.seconds).toBeCloseTo((100 * MS + 132 * 10 * BIT) / CLOCK, 6);
    expect(tape.readRecord()).toEqual(r1);
    expect(tape.readRecord()).toBeNull();
  });

  it('loses a record the tape has run past while the motor was on', () => {
    const r0 = record(CAS_FULL, () => 1);
    const r1 = record(CAS_FULL, () => 2);
    const r2 = record(CAS_FULL, () => 3);
    const tape = new AtariCassette(CLOCK);
    tape.mount(casOf(chunk('baud', 600),
      chunk('data', 100, [...r0]), chunk('data', 250, [...r1]), chunk('data', 3000, [...r2])), 'd.cas');
    expect(tape.readRecord()).toEqual(r0);
    // Run through the gap and all of record 1.
    tape.advance(250 * MS + 132 * 10 * BIT + 1);
    expect(tape.readRecord()).toEqual(r2);
  });

  it('skips the rest of a part-read file the tape ran past, and its EOF', () => {
    // A loader reads one record of file 1, stops, then the OS runs the motor
    // through its pre-read wait: file 1's last record and EOF go by.
    const a0 = record(CAS_FULL, () => 1);
    const a1 = record(CAS_FULL, () => 2);
    const eof = record(CAS_EOF, () => 0);
    const b0 = record(CAS_FULL, () => 3);
    const tape = new AtariCassette(CLOCK);
    tape.mount(casOf(chunk('baud', 600), chunk('data', 100, [...a0]), chunk('data', 250, [...a1]),
      chunk('data', 250, [...eof]), chunk('data', 12000, [...b0])), 'g.cas');
    expect(tape.readRecord()).toEqual(a0);
    tape.advance(10_000 * MS);
    expect(tape.readRecord()).toEqual(b0);
  });

  it('reads an unread file from its first record when the motor ran into it', () => {
    // A leader shorter than the OS's wait before it reads.
    const a0 = record(CAS_FULL, () => 1);
    const a1 = record(CAS_FULL, () => 2);
    const tape = new AtariCassette(CLOCK);
    tape.mount(casOf(chunk('baud', 600), chunk('data', 250, [...a0]), chunk('data', 250, [...a1])), 'h.cas');
    tape.advance(250 * MS + 132 * 10 * BIT + 300 * MS); // into a1's signal
    expect(tape.readRecord()).toEqual(a0);
    expect(tape.readRecord()).toEqual(a1);
  });

  it('still gives a record whose first bits have just gone by', () => {
    const r0 = record(CAS_FULL, () => 1);
    const tape = new AtariCassette(CLOCK);
    tape.mount(casOf(chunk('baud', 600), chunk('data', 100, [...r0])), 'e.cas');
    tape.advance(100 * MS + 20 * BIT);
    expect(tape.readRecord()).toEqual(r0);
  });

  it('names as current the file the next read comes from', () => {
    const a0 = record(CAS_FULL, () => 1);
    const a1 = record(CAS_FULL, () => 2);
    const eof = record(CAS_EOF, () => 0);
    const b0 = record(CAS_FULL, () => 3);
    const b1 = record(CAS_EOF, () => 0);
    const tape = new AtariCassette(CLOCK);
    tape.mount(casOf(chunk('baud', 600), chunk('data', 250, [...a0]), chunk('data', 250, [...a1]),
      chunk('data', 250, [...eof]), chunk('data', 12000, [...b0]), chunk('data', 250, [...b1])), 'k.cas');
    // The motor has run past the whole tape before any read: the next read
    // still starts file 1.
    tape.advance(60_000 * MS);
    expect(tape.currentFile()).toBe(0);
    expect(tape.readRecord()).toEqual(a0);
    expect(tape.currentFile()).toBe(0);
    // Part way through file 1, the motor runs into file 2's leader.
    tape.advance(10_000 * MS);
    expect(tape.currentFile()).toBe(1);
    expect(tape.readRecord()).toEqual(b0);
    expect(tape.readRecord()).toEqual(b1);
    expect(tape.currentFile()).toBe(-1);
    expect(tape.readRecord()).toBeNull();
  });
});

// ── POKEY serial receiver ──────────────────────────────────────────────────

/** A line driven from a list of bytes framed 8N1, `bit` cycles a bit, after
 *  `lead` cycles of mark. `stop` overrides the stop bit level. */
class Line {
  t = 0;
  constructor(private readonly bytes: number[], private readonly bit: number,
              private readonly lead: number, private readonly stop = 1) {}
  level(): number {
    const u = this.t - this.lead;
    if (u < 0) return 1;
    const n = Math.floor(u / this.bit);
    const byte = Math.floor(n / 10);
    if (byte >= this.bytes.length) return 1;
    const k = n % 10;
    if (k === 0) return 0;
    if (k === 9) return this.stop;
    return (this.bytes[byte] >> (k - 1)) & 1;
  }
}

/** POKEY set up as the OS sets it for 600 baud cassette reads. */
function receiver(line: Line): Pokey {
  const p = new Pokey(1_789_773);
  p.serialIn = () => line.level();
  p.writeReg(0x08, 0x28); // AUDCTL: ch3 at 1.79 MHz, 3+4 joined
  p.writeReg(0x04, 0xcc); // AUDF3
  p.writeReg(0x06, 0x05); // AUDF4: $05CC + 7 = 1491 cycles
  p.writeReg(0x0f, 0x13); // SKCTL: async receive from channel 4, keyboard on
  p.writeReg(0x0e, 0x20); // IRQEN: serial input ready
  return p;
}

/** Run `p` and the line on in 4-cycle steps (an average instruction). */
function run(p: Pokey, line: Line, cycles: number, onByte?: () => void): void {
  for (let c = 0; c < cycles; c += 4) {
    line.t += 4;
    p.advance(4);
    if (onByte && (p.readReg(0x0e) & 0x20) === 0) onByte();
  }
}

describe('pokey serial input', () => {
  const OS_BIT = 2982;

  it('reads the data-in line on SKSTAT bit 4', () => {
    const line = new Line([0x00], OS_BIT, 100);
    const p = receiver(line);
    expect(p.readReg(0x0f) & 0x10).toBe(0x10);
    run(p, line, 100 + OS_BIT / 2);
    expect(p.readReg(0x0f) & 0x10).toBe(0); // the start bit
  });

  it('assembles 8N1 bytes into SERIN and raises the serial-input interrupt', () => {
    const bytes = [0x55, 0x55, 0xfc, 0x00, 0xff, 0xa5, 0x3c];
    const line = new Line(bytes, OS_BIT, 1000);
    const p = receiver(line);
    const got: number[] = [];
    run(p, line, 1000 + bytes.length * 10 * OS_BIT + 5000, () => {
      got.push(p.readReg(0x0d));
      expect(p.irq).toBe(true);
      // Acknowledge as the OS does: clear the IRQEN bit, then set it again.
      p.writeReg(0x0e, 0x00);
      p.writeReg(0x0e, 0x20);
    });
    expect(got).toEqual(bytes);
    expect(p.readReg(0x0f) & 0xa0).toBe(0xa0); // no framing error or overrun
  });

  it('reports a byte shifting in on SKSTAT bit 1', () => {
    const line = new Line([0x00], OS_BIT, 100);
    const p = receiver(line);
    expect(p.readReg(0x0f) & 0x02).toBe(0x02);
    run(p, line, 100 + 3 * OS_BIT);
    expect(p.readReg(0x0f) & 0x02).toBe(0);
    run(p, line, 8 * OS_BIT);
    expect(p.readReg(0x0f) & 0x02).toBe(0x02);
  });

  it('latches a framing error when the stop bit is 0, until SKRES', () => {
    const line = new Line([0x12], OS_BIT, 100, 0);
    const p = receiver(line);
    run(p, line, 100 + 10 * OS_BIT + 100);
    expect(p.readReg(0x0d)).toBe(0x12);
    expect(p.readReg(0x0f) & 0x80).toBe(0);
    p.writeReg(0x0a, 0); // SKRES
    expect(p.readReg(0x0f) & 0x80).toBe(0x80);
  });

  it('latches an overrun when a byte arrives before the last was acknowledged', () => {
    const line = new Line([0x01, 0x02], OS_BIT, 100);
    const p = receiver(line);
    run(p, line, 100 + 20 * OS_BIT + 100);
    expect(p.readReg(0x0d)).toBe(0x02);
    expect(p.readReg(0x0f) & 0x20).toBe(0);
  });

  it('times bits from the 8-bit channel 4 divider at 64 kHz and 15 kHz', () => {
    for (const [audctl, audf4, base] of [[0x00, 9, 28], [0x01, 1, 114]] as const) {
      const bit = 2 * (audf4 + 1) * base; // 560 and 456 cycles
      const line = new Line([0x96, 0x69], bit, 50);
      const p = new Pokey(1_789_773);
      p.serialIn = () => line.level();
      p.writeReg(0x08, audctl);
      p.writeReg(0x06, audf4);
      p.writeReg(0x0f, 0x13);
      p.writeReg(0x0e, 0x20);
      const got: number[] = [];
      run(p, line, 50 + 20 * bit + 200, () => {
        got.push(p.readReg(0x0d));
        p.writeReg(0x0e, 0x00);
        p.writeReg(0x0e, 0x20);
      });
      expect(got).toEqual([0x96, 0x69]);
    }
  });

  it('receives nothing when SKCTL expects the clock from the device', () => {
    const line = new Line([0x42], OS_BIT, 100);
    const p = receiver(line);
    p.writeReg(0x0f, 0x03); // mode 0: external clocks
    run(p, line, 100 + 12 * OS_BIT);
    expect(p.readReg(0x0e) & 0x20).toBe(0x20);
    expect(p.readReg(0x0d)).toBe(0xff);
  });
});

// ── Loaders that read the recorder themselves ──────────────────────────────

const PAYLOAD = record(CAS_FULL, i => (i * 7 + 3));

/** A machine with no OS, the tape mounted and `code` at $0600, started
 *  there. */
function loaderMachine(code: number[], tape: Uint8Array): AtariMachine {
  const m = new AtariMachine('atari800', null);
  m.services.tape.mount(tape, 'loader.cas');
  m.setSpeedMultiplier(0);
  m.reset();
  for (let i = 0; i < code.length; i++) m.memory.writeByte(0x0600 + i, code[i]);
  m.cpu.pc = 0x0600;
  return m;
}

function runUntil(m: AtariMachine, pc: number, frames: number): void {
  for (let f = 0; f < frames && m.cpu.pc !== pc; f++) m.tick();
}

describe('atari loaders reading the recorder through POKEY', () => {
  const tape = writeAtariCas({ description: 'loader', records: [{ data: PAYLOAD, baud: 600, gapMs: 300 }] });

  it('a loader polling IRQST and SERIN reads a record', () => {
    // SEI; NMIEN=DMACTL=0; AUDCTL=$28, AUDF3/4=$05CC, SKCTL=$13, SKRES,
    // IRQEN=$20; motor on (PACTL=$34). Then for 132 bytes: wait for IRQST
    // bit 5 low, store SERIN at $4000,X, acknowledge through IRQEN. Motor
    // off and spin at $064D.
    const code = [
      0x78, 0xa9, 0x00, 0x8d, 0x0e, 0xd4, 0x8d, 0x00, 0xd4,
      0xa9, 0x28, 0x8d, 0x08, 0xd2, 0xa9, 0xcc, 0x8d, 0x04, 0xd2,
      0xa9, 0x05, 0x8d, 0x06, 0xd2, 0xa9, 0x13, 0x8d, 0x0f, 0xd2,
      0x8d, 0x0a, 0xd2, 0xa9, 0x20, 0x8d, 0x0e, 0xd2,
      0xa9, 0x34, 0x8d, 0x02, 0xd3, 0xa2, 0x00,
      0xad, 0x0e, 0xd2, 0x29, 0x20, 0xd0, 0xf9,             // $062C wait
      0xad, 0x0d, 0xd2, 0x9d, 0x00, 0x40,
      0xa9, 0x00, 0x8d, 0x0e, 0xd2, 0xa9, 0x20, 0x8d, 0x0e, 0xd2,
      0xe8, 0xe0, 0x84, 0xd0, 0xe4,
      0xa9, 0x3c, 0x8d, 0x02, 0xd3, 0x4c, 0x4d, 0x06,       // $0648
    ];
    const m = loaderMachine(code, tape);
    try {
      runUntil(m, 0x064d, 400);
      expect(m.cpu.pc).toBe(0x064d);
      expect([...m.memory.readBlock(0x4000, 132)]).toEqual([...PAYLOAD]);
      expect(m.cassetteMotor).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('a loader timing bits itself from SKSTAT bit 4 reads a record', () => {
    // SKCTL=0 (no receiver), motor on. For each byte: wait for the start
    // bit on SKSTAT bit 4, wait half a bit (13 lines through WSYNC), then
    // eight times wait a bit (26 lines) and ROR bit 4 into $80. Store it at
    // $4000,X, wait for the stop bit, repeat for 132 bytes.
    const code = [
      0x78, 0xa9, 0x00, 0x8d, 0x0e, 0xd4, 0x8d, 0x00, 0xd4, 0x8d, 0x0f, 0xd2,
      0xa9, 0x34, 0x8d, 0x02, 0xd3, 0xa2, 0x00,
      0xad, 0x0f, 0xd2, 0x29, 0x10, 0xd0, 0xf9,             // $0613 byte
      0xa0, 0x0d, 0x20, 0x51, 0x06,
      0xa9, 0x08, 0x85, 0x81,
      0xa0, 0x1a, 0x20, 0x51, 0x06,                         // $0623 bit
      0xad, 0x0f, 0xd2, 0x29, 0x10, 0xc9, 0x10, 0x66, 0x80,
      0xc6, 0x81, 0xd0, 0xee,
      0xa5, 0x80, 0x9d, 0x00, 0x40, 0xe8, 0xe0, 0x84, 0xf0, 0x0a,
      0xad, 0x0f, 0xd2, 0x29, 0x10, 0xf0, 0xf9,             // $063F stop
      0x4c, 0x13, 0x06,
      0xa9, 0x3c, 0x8d, 0x02, 0xd3, 0x4c, 0x4e, 0x06,       // $0649 done
      0x8d, 0x0a, 0xd4, 0x88, 0xd0, 0xfa, 0x60,             // $0651 lines
    ];
    expect(code.length).toBe(0x58);
    const m = loaderMachine(code, tape);
    try {
      runUntil(m, 0x064e, 400);
      expect(m.cpu.pc).toBe(0x064e);
      expect([...m.memory.readBlock(0x4000, 132)]).toEqual([...PAYLOAD]);
    } finally {
      m.destroy();
    }
  });

  it('holds the tape and the line idle while the motor is off', () => {
    // Everything but the motor: spin at $0600 with the motor line high.
    const m = loaderMachine([0x78, 0xa9, 0x3c, 0x8d, 0x02, 0xd3, 0x4c, 0x06, 0x06], tape);
    try {
      for (let f = 0; f < 200; f++) m.tick();
      expect(m.cassetteMotor).toBe(false);
      expect(m.cassette.seconds).toBe(0);
      expect(m.pokey.readReg(0x0f) & 0x10).toBe(0x10);
    } finally {
      m.destroy();
    }
  });

  it('runs the motor and asserts the SIO command only while C2 is driven low', () => {
    // The 6821 drives C2 from control-register bit 3 only in manual output
    // mode (bits 5-4 = 11). As an input (bit 5 clear) the pin is undriven
    // and reads high; the handshake modes (10) leave it high between port
    // accesses.
    const m = new AtariMachine('atari800', null);
    try {
      const cases: [number, boolean][] = [
        [0x34, true], [0x3c, false], [0x30, true], [0x38, false],
        [0x00, false], [0x04, false], [0x24, false], [0x2c, false],
      ];
      for (const [cr, low] of cases) {
        m.memory.writeByte(0xd302, cr); // PACTL: CA2 = motor
        m.memory.writeByte(0xd303, cr); // PBCTL: CB2 = SIO command
        expect([cr, m.cassetteMotor]).toEqual([cr, low]);
        expect([cr, m.sioCommand]).toEqual([cr, low]);
      }
    } finally {
      m.destroy();
    }
  });

  it('keeps the tape still when PACTL leaves CA2 as an input', () => {
    // As the motor-off case, but PACTL = $04: port A selected, CA2 input.
    const m = loaderMachine([0x78, 0xa9, 0x04, 0x8d, 0x02, 0xd3, 0x4c, 0x06, 0x06], tape);
    try {
      for (let f = 0; f < 100; f++) m.tick();
      expect(m.cassette.seconds).toBe(0);
    } finally {
      m.destroy();
    }
  });

  it('a POKEY loader that waits on WSYNC between polls reads a fast tape', () => {
    // 9600 baud: a bit is about 185 cycles, under two scanlines, so a
    // 114-cycle WSYNC wait is a large part of one. AUDCTL $28 with
    // AUDF4:AUDF3 = $0055 gives a channel-4 period of $55 + 7 = 92 cycles,
    // 184 a bit. As the IRQST loader, but each poll is STA WSYNC; LDA IRQST.
    const fast = writeAtariCas({ description: 'fast', records: [{ data: PAYLOAD, baud: 9600, gapMs: 300 }] });
    const code = [
      0x78, 0xa9, 0x00, 0x8d, 0x0e, 0xd4, 0x8d, 0x00, 0xd4,
      0xa9, 0x28, 0x8d, 0x08, 0xd2, 0xa9, 0x55, 0x8d, 0x04, 0xd2,
      0xa9, 0x00, 0x8d, 0x06, 0xd2, 0xa9, 0x13, 0x8d, 0x0f, 0xd2,
      0x8d, 0x0a, 0xd2, 0xa9, 0x20, 0x8d, 0x0e, 0xd2,
      0xa9, 0x34, 0x8d, 0x02, 0xd3, 0xa2, 0x00,
      0x8d, 0x0a, 0xd4, 0xad, 0x0e, 0xd2, 0x29, 0x20, 0xd0, 0xf6, // $062C wait
      0xad, 0x0d, 0xd2, 0x9d, 0x00, 0x40,
      0xa9, 0x00, 0x8d, 0x0e, 0xd2, 0xa9, 0x20, 0x8d, 0x0e, 0xd2,
      0xe8, 0xe0, 0x84, 0xd0, 0xe1,
      0xa9, 0x3c, 0x8d, 0x02, 0xd3, 0x4c, 0x50, 0x06,             // $064B
    ];
    expect(code.length).toBe(0x53);
    const m = loaderMachine(code, fast);
    try {
      runUntil(m, 0x0650, 100);
      expect(m.cpu.pc).toBe(0x0650);
      expect([...m.memory.readBlock(0x4000, 132)]).toEqual([...PAYLOAD]);
    } finally {
      m.destroy();
    }
  });
});

// ── Real OS reading the tape bit by bit ────────────────────────────────────

const DIR = process.env.ATARI_ROM_DIR ?? resolve(__dirname, '../../mcp/.cache');
const OS_B = resolve(DIR, 'atariosb.rom');
const OS_XL = [resolve(DIR, 'atari800xl.rom'), resolve(DIR, 'REV02.ROM')].find(existsSync) ?? '';
const BASIC = resolve(DIR, 'ataribas.rom');
const haveBasic = existsSync(BASIC);

function key(code: string, k: string, shift = false): HostKeyEvent {
  return { code, key: k, shift, ctrl: false, alt: false };
}
function charKey(ch: string): HostKeyEvent {
  if (ch === '\n') return key('Enter', 'Enter');
  if (ch === ' ') return key('Space', ' ');
  if (ch === '"') return key('Digit2', '"', true);
  if (/[A-Z]/.test(ch)) return key(`Key${ch}`, ch.toLowerCase());
  if (/[0-9]/.test(ch)) return key(`Digit${ch}`, ch);
  return key('Equal', ch);
}
function type(m: AtariMachine, text: string): void {
  for (const ch of text) {
    const e = charKey(ch);
    m.keyDown(e);
    for (let f = 0; f < 3; f++) m.tick();
    m.keyUp(e);
    for (let f = 0; f < 3; f++) m.tick();
  }
}
function rows(m: AtariMachine): string[] {
  const sav = m.memory.readByte(0x58) | (m.memory.readByte(0x59) << 8);
  const out: string[] = [];
  for (let r = 0; r < 24; r++) {
    let s = '';
    for (let c = 0; c < 40; c++) {
      const v = m.memory.readByte(sav + r * 40 + c) & 0x7f;
      const a = v < 0x40 ? v + 0x20 : v < 0x60 ? v - 0x40 : v;
      s += a >= 0x20 && a < 0x7f ? String.fromCharCode(a) : ' ';
    }
    if (s.trim()) out.push(s.trim());
  }
  return out;
}
/** An 800 with OS-B and the BASIC cartridge, or an 800XL with its OS and
 *  built-in BASIC, at the READY prompt. */
function bootBasic(model: 'atari800' | 'atari800xl', region: 'ntsc' | 'pal'): AtariMachine {
  const m = new AtariMachine(model, null, region);
  const basic = new Uint8Array(readFileSync(BASIC));
  if (model === 'atari800xl') {
    m.services.roms.installSystemRom(new Uint8Array([...readFileSync(OS_XL), ...basic]));
  } else {
    m.services.roms.installSystemRom(new Uint8Array(readFileSync(OS_B)));
    m.services.roms.cartridge!.insert(basic, '');
  }
  m.reset();
  m.setSpeedMultiplier(0);
  for (let f = 0; f < 200; f++) m.tick();
  return m;
}

/** CSAVE a line on one machine, then CLOAD it on `loader` with the SIO fast
 *  path off, so the OS's own cassette routine measures the baud rate from
 *  the $55 $55 bytes and reads every bit through POKEY. */
function cloadBitByBit(loader: AtariMachine): void {
  const saver = bootBasic('atari800', 'ntsc');
  try {
    type(saver, '10 PRINT "BIT BY BIT"\nCSAVE\n');
    for (let f = 0; f < 30; f++) saver.tick();
    type(saver, '\n'); // "press RECORD and PLAY, then RETURN"
    for (let f = 0; f < 3000 && rows(saver).at(-1) !== 'READY'; f++) saver.tick();
    const tape = saver.services.tape.recordedBytes();
    expect(tape).not.toBeNull();

    loader.sio.cassetteFastPath = false;
    let fastReads = 0;
    const handle = loader.sio.handle.bind(loader.sio);
    loader.sio.handle = () => { fastReads++; handle(); };
    loader.services.tape.mount(tape!.data, tape!.filename);
    type(loader, 'CLOAD\n');
    for (let f = 0; f < 30; f++) loader.tick();
    type(loader, '\n'); // "press PLAY, then RETURN"
    // The 20 s leader, then each record at 600 baud.
    for (let f = 0; f < 4000 && rows(loader).at(-1) !== 'READY'; f++) loader.tick();
    expect(rows(loader)).not.toContain('ERROR-   143');
    type(loader, 'LIST\n');
    for (let f = 0; f < 30; f++) loader.tick();
    expect(rows(loader)).toContain('10 PRINT "BIT BY BIT"');
    expect(fastReads).toBe(0);
    expect(loader.cassette.seconds).toBeGreaterThan(20); // it played the leader
  } finally {
    saver.destroy();
  }
}

describe('atari OS reading the recorder bit by bit', { timeout: 120_000 }, () => {
  // OS-B here is the NTSC ROM: its baud measurement counts 262-line frames,
  // so it is run on the machine it was written for.
  it.skipIf(!haveBasic || !existsSync(OS_B))('CLOADs through the OS-B SIO routine on an NTSC 800', () => {
    const m = bootBasic('atari800', 'ntsc');
    try {
      cloadBitByBit(m);
    } finally {
      m.destroy();
    }
  });

  // The XL OS reads GTIA's PAL flag and measures for either standard.
  it.skipIf(!haveBasic || OS_XL === '')('CLOADs through the XL OS SIO routine on a PAL 800XL', () => {
    const m = bootBasic('atari800xl', 'pal');
    try {
      cloadBitByBit(m);
    } finally {
      m.destroy();
    }
  });
});

describe('atari turbo while loading', () => {
  const tape = () => casOf(chunk('baud', 600), chunk('data', 5000, [...record(CAS_FULL, () => 0)]));

  it('runs flat out only while the motor plays a tape that has more to play', () => {
    const m = new AtariMachine('atari800', null, 'pal');
    try {
      const inTurbo = () => (m as unknown as { inTurbo(): boolean }).inTurbo();
      expect(inTurbo()).toBe(false);
      m.services.tape!.mount(tape(), 'game.cas');
      expect(m.cassette.loaded).toBe(true);
      expect(inTurbo()).toBe(false); // motor off: the tape sits still
      m.cassetteMotor = true;
      expect(m.tapeLoadingActive).toBe(true);
      expect(inTurbo()).toBe(true);
      m.tapeTurbo = false; // the "Turbo while loading" option
      expect(inTurbo()).toBe(false);
      m.tapeTurbo = true;
      m.cassette.advance(m.cpuClockHz * 60); // run off the end of the tape
      expect(m.cassette.finished).toBe(true);
      expect(inTurbo()).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('stays on for a few seconds after a record is read, since the motor is off between records', () => {
    const m = new AtariMachine('atari800', null, 'pal');
    try {
      const inTurbo = () => (m as unknown as { inTurbo(): boolean }).inTurbo();
      m.services.tape!.mount(tape(), 'game.cas');
      expect(m.cassetteMotor).toBe(false);
      expect(inTurbo()).toBe(false);
      m.noteTapeRead(); // a BASIC loader's GET: the OS ran the motor for this record only
      expect(inTurbo()).toBe(true);
      for (let f = 0; f < 3 * 50 - 1; f++) m.tick();
      expect(inTurbo()).toBe(true);
      for (let f = 0; f < 3; f++) m.tick();
      expect(inTurbo()).toBe(false); // let go soon after the last read
    } finally {
      m.destroy();
    }
  });

  it('shows the recorder playing while it loads, and never paused', () => {
    const m = new AtariMachine('atari800', null, 'pal');
    try {
      const out = { driveLed: new Int8Array(4), driveTrack: new Int16Array(4), driveSector: new Int16Array(4), driveDirty: new Uint8Array(4) } as never;
      m.services.tape!.mount(tape(), 'game.cas');
      m.services.probe.sample(out);
      expect(out).toMatchObject({ tapeLoaded: true, tapePlaying: false, tapePaused: false, tapeTurbo: false });
      m.cassetteMotor = true;
      m.services.probe.sample(out);
      expect(out).toMatchObject({ tapeLoaded: true, tapePlaying: true, tapePaused: false, tapeTurbo: true });
    } finally {
      m.destroy();
    }
  });

  it('reads the setting from the shell', () => {
    const m = new AtariMachine('atari800', null, 'pal');
    try {
      m.applySettings({ get: (key: string, fallback: unknown) => (key === 'tape-turbo-load' ? false : fallback) } as never);
      expect(m.tapeTurbo).toBe(false);
    } finally {
      m.destroy();
    }
  });
});
