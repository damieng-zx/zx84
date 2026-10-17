/**
 * UEF codec tests. Expectations are derived from the Acorn cassette format
 * (BBC Microcomputer User Guide): 1200 baud, a 0 bit is one cycle of 1200 Hz and
 * a 1 bit is two cycles of 2400 Hz, a byte is a 0 start bit, eight data bits
 * LSB first and a 1 stop bit — so a byte lasts exactly 10/1200 s.
 */

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  buildUef, parseUEF, describeCfsBlock, UefRecorder, type UefChunk,
} from '@/media/tape/uef.ts';
import { TapeDeck, TAPE_REF_HZ, type CswBlock, type TapeBlock } from '@/media/tape/tap.ts';
import { CassetteFsk } from '@/machines/shared/cassette-fsk.ts';
import { AsyncSerialReceiver } from '@/utils/async-serial-rx.ts';

const chunk = (id: number, ...data: number[]): UefChunk => ({ id, data: Uint8Array.from(data) });
const sum = (p: Uint32Array): number => p.reduce((a, b) => a + b, 0);
const csw = (b: TapeBlock): CswBlock => {
  if (b.kind !== 'csw') throw new Error(`expected csw, got ${b.kind}`);
  return b;
};

describe('UEF parsing', () => {
  it('rejects a file without the UEF signature', async () => {
    await expect(parseUEF(new Uint8Array(32))).rejects.toThrow(/UEF/);
  });

  it('turns a 0x00 data byte into 9 cycles of 1200 Hz then a 2400 Hz stop bit', async () => {
    const blocks = await parseUEF(buildUef([chunk(0x0100, 0x00)]));
    expect(blocks).toHaveLength(1);
    const b = csw(blocks[0]);
    // start + 8 zero bits = 9 cycles (18 half-cycles); stop bit = 2 cycles (4 halves).
    expect(b.pulses.length).toBe(18 + 4);
    expect(Math.abs(sum(b.pulses) - TAPE_REF_HZ * 10 / 1200)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.pulses[0] - TAPE_REF_HZ / 2400)).toBeLessThanOrEqual(1);   // 1200 Hz half
    expect(Math.abs(b.pulses[21] - TAPE_REF_HZ / 4800)).toBeLessThanOrEqual(1);  // 2400 Hz half
  });

  it('sends data bits LSB first (0x01 has a single 2400 Hz bit straight after the start bit)', async () => {
    const b = csw((await parseUEF(buildUef([chunk(0x0100, 0x01)])))[0]);
    const long = TAPE_REF_HZ / 2400, short = TAPE_REF_HZ / 4800;
    expect(Math.abs(b.pulses[0] - long)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.pulses[1] - long)).toBeLessThanOrEqual(1);
    for (let i = 2; i < 6; i++) expect(Math.abs(b.pulses[i] - short)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.pulses[6] - long)).toBeLessThanOrEqual(1);  // bit 1 = 0 again
  });

  it('does not drift: 1200 bytes last exactly 10 seconds', async () => {
    const data = Uint8Array.from({ length: 1200 }, (_, i) => i & 0xFF);
    const b = csw((await parseUEF(buildUef([{ id: 0x0100, data }])))[0]);
    expect(Math.abs(sum(b.pulses) - TAPE_REF_HZ * 10)).toBeLessThanOrEqual(1);
  });

  it('plays 300 baud (chunk 0117) four times slower', async () => {
    const blocks = await parseUEF(buildUef([chunk(0x0117, 0x2C, 0x01), chunk(0x0100, 0x55)]));
    expect(Math.abs(sum(csw(blocks[0]).pulses) - TAPE_REF_HZ * 10 / 300)).toBeLessThanOrEqual(1);
  });

  it('turns carrier cycles into 2400 Hz tone', async () => {
    const blocks = await parseUEF(buildUef([chunk(0x0110, 0x60, 0x09)]));   // 2400 cycles = 1 s
    const b = csw(blocks[0]);
    expect(b.pulses.length).toBe(4800);
    expect(Math.abs(sum(b.pulses) - TAPE_REF_HZ)).toBeLessThanOrEqual(1);
  });

  it('turns gaps into pauses, never into a zero-length stop-the-tape', async () => {
    const blocks = await parseUEF(buildUef([
      chunk(0x0112, 0x60, 0x09),                                                   // 2400 half-units = 1 s
      { id: 0x0116, data: new Uint8Array(new Float32Array([0.5]).buffer) },        // 0.5 s float gap
      { id: 0x0116, data: new Uint8Array(new Float32Array([0.0001]).buffer) },
    ]));
    expect(blocks.map(b => b.kind === 'pause' ? b.duration : -1)).toEqual([1000, 500, 1]);
  });

  it('accepts gzip-wrapped images', async () => {
    const raw = buildUef([chunk(0x0100, 0x41)]);
    const blocks = await parseUEF(new Uint8Array(gzipSync(raw)));
    expect(blocks).toHaveLength(1);
  });

  it('handles the explicit-bit chunk with padding bits', async () => {
    // One padding bit in the last byte: 15 one-bits, LSB first.
    const b = csw((await parseUEF(buildUef([chunk(0x0102, 1, 0xFF, 0x7F)])))[0]);
    expect(b.pulses.length).toBe(60);       // 15 bits × 2 cycles × 2 halves
  });

  it('adds the even-parity bit in the defined-format chunk', async () => {
    // 8 data bits, even parity ('E' = 0x45), 1 stop bit. 0x01 has one 1 → parity bit 1.
    const b = csw((await parseUEF(buildUef([chunk(0x0104, 8, 0x45, 1, 0x01)])))[0]);
    // zeros: start + seven data = 8 cycles → 16 halves; ones: data bit 0, parity, stop = 3 × 4 halves
    expect(b.pulses.length).toBe(16 + 12);
  });
});

describe('CFS block description', () => {
  it('reads name, block number and load/exec from a cassette-filing-system block', () => {
    const bytes = Uint8Array.from([
      0x2A, ...Array.from('GAME', c => c.charCodeAt(0)), 0x00,
      0x00, 0x19, 0x00, 0x00,   // load &1900
      0x23, 0x80, 0xFF, 0xFF,   // exec
      0x00, 0x00,               // block 0
      0x00, 0x01,               // length 256
      0x80,                     // last block
      0, 0, 0, 0, 0, 0,
    ]);
    const d = describeCfsBlock(bytes)!;
    expect(d.label).toBe('GAME block 00 (last)');
    expect(d.detail).toContain('256 bytes');
    expect(d.detail).toContain('&00001900');
  });

  it('returns null for data that is not a CFS block', () => {
    expect(describeCfsBlock(Uint8Array.from([1, 2, 3]))).toBeNull();
  });
});

describe('UEF → deck → demodulator → UART round trip', () => {
  const CPU = 2_000_000;

  function playThrough(blocks: TapeBlock[], baud = 1200): { got: number[]; carrierDuring: boolean[] } {
    const deck = new TapeDeck(CPU);
    deck.pulseScale = CPU / TAPE_REF_HZ;
    deck.blocks = blocks;
    deck.startPlayback();
    const fsk = new CassetteFsk(CPU);
    const rx = new AsyncSerialReceiver();
    rx.bitCycles = CPU / baud;
    const got: number[] = [];
    rx.onFrame = f => { if (!f.framingError) got.push(f.value); };
    let now = 0;
    let prevEar = deck.earBit;
    const carrierDuring: boolean[] = [];
    // Step like a 6502 retiring 2-7 cycle instructions.
    const steps = [3, 2, 4, 5, 3, 7, 2];
    for (let i = 0; deck.playing && i < 20_000_000; i++) {
      const n = steps[i % steps.length];
      deck.advance(n);
      now += n;
      if (deck.earBit !== prevEar) { prevEar = deck.earBit; fsk.edge(now); }
      fsk.update(now);
      rx.step(now, fsk.level, fsk.levelSince, fsk.startLevel);
      if (i % 1000 === 0) carrierDuring.push(fsk.carrier);
    }
    return { got, carrierDuring };
  }

  it('recovers every byte of a carrier-led block, including 0x00 and 0xFF runs', async () => {
    const payload = [0x2A, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x55, 0xAA, 0x01, 0x80, 0xFE];
    const blocks = await parseUEF(buildUef([
      chunk(0x0110, 0xB0, 0x04),          // 1200 cycles = 0.5 s lead-in
      chunk(0x0100, ...payload),
      chunk(0x0110, 0x60, 0x00),
    ]));
    expect(playThrough(blocks).got).toEqual(payload);
  });

  it('decodes a 300 baud tape with a 300 baud receiver clock', async () => {
    const payload = [0x12, 0x34, 0xF0];
    const blocks = await parseUEF(buildUef([
      chunk(0x0117, 0x2C, 0x01),
      chunk(0x0110, 0xB0, 0x04),
      chunk(0x0100, ...payload),
      chunk(0x0110, 0x60, 0x00),
    ]));
    expect(playThrough(blocks, 300).got).toEqual(payload);
  });

  it('asserts carrier detect during the leader', async () => {
    const blocks = await parseUEF(buildUef([chunk(0x0110, 0xB0, 0x04), chunk(0x0100, 0x00)]));
    expect(playThrough(blocks).carrierDuring.some(Boolean)).toBe(true);
  });

  it('never decodes a byte from an unmodulated leader or from silence', async () => {
    const blocks = await parseUEF(buildUef([
      chunk(0x0110, 0xB0, 0x04), chunk(0x0112, 0x60, 0x09), chunk(0x0110, 0xB0, 0x04),
    ]));
    expect(playThrough(blocks).got).toEqual([]);
  });
});

describe('UefRecorder', () => {
  it('records back-to-back bytes as data and idle time as carrier', () => {
    const CPU = 2_000_000, frame = CPU / 120;       // 10 bits at 1200 baud
    const rec = new UefRecorder(CPU);
    expect(rec.toUef()).toBeNull();
    rec.motor(true, 0);
    rec.byte(0x41, CPU / 2);                          // 0.5 s of leader first
    rec.byte(0x42, CPU / 2 + frame);                  // contiguous
    rec.byte(0x43, CPU / 2 + frame * 2 + CPU);        // 1 s of carrier then another byte
    const uef = rec.toUef()!;
    const view = new DataView(uef.buffer, uef.byteOffset, uef.byteLength);
    const ids: number[] = [];
    const lens: number[] = [];
    const offs: number[] = [];
    for (let pos = 12; pos < uef.length;) {
      ids.push(view.getUint16(pos, true));
      const len = view.getUint32(pos + 2, true);
      lens.push(len);
      offs.push(pos + 6);
      pos += 6 + len;
    }
    expect(ids).toEqual([0x0000, 0x0110, 0x0100, 0x0110, 0x0100]);
    expect(lens[2]).toBe(2);
    // 0.5 s of 2400 Hz = 1200 cycles, 1.0 s = 2400 cycles
    expect(view.getUint16(offs[1], true)).toBe(1200);
    expect(view.getUint16(offs[3], true)).toBe(2400);
  });
});
