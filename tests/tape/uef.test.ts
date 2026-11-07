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
import { parseAcornTape } from '@/machines/shared/acorn-tape-service.ts';
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

  it('a carrier with a dummy byte (0111) puts &AA on the tape between the two stretches of tone', async () => {
    const payload = [0x2A, 0x41, 0x42];
    const blocks = await parseUEF(buildUef([
      chunk(0x0111, 0xB0, 0x04, 0x60, 0x00),   // 1200 cycles, the dummy byte, 96 cycles
      chunk(0x0100, ...payload),
      chunk(0x0110, 0x60, 0x00),
    ]));
    expect(playThrough(blocks).got).toEqual([0xAA, ...payload]);
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

  it('does not count time with the motor off as carrier', () => {
    const CPU = 2_000_000, frame = CPU / 120;
    const rec = new UefRecorder(CPU);
    rec.motor(true, 0);
    rec.byte(0x41, 0);
    rec.motor(false, frame);
    rec.motor(true, CPU * 20);                        // 20 s later
    rec.byte(0x42, CPU * 20);
    const uef = rec.toUef()!;
    const view = new DataView(uef.buffer, uef.byteOffset, uef.byteLength);
    const ids: number[] = [];
    for (let pos = 12; pos < uef.length;) {
      ids.push(view.getUint16(pos, true));
      pos += 6 + view.getUint32(pos + 2, true);
    }
    expect(ids).toEqual([0x0000, 0x0100, 0x0100]);
  });
});

describe('parseAcornTape', () => {
  it('chooses UEF or CSW by content, whatever the file is called', async () => {
    const uef = buildUef([chunk(0x0110, 0x10, 0x00)]);
    expect((await parseAcornTape(uef)).length).toBeGreaterThan(0);
    expect((await parseAcornTape(new Uint8Array(gzipSync(uef)))).length).toBeGreaterThan(0);
    await expect(parseAcornTape(new Uint8Array(40))).rejects.toThrow();   // neither UEF nor CSW
  });
});

// ── Chunks beyond plain data and carrier (UEF specification 0.10) ──────────

describe('UEF carrier, gap, security-cycle and phase chunks', () => {
  const LONG = TAPE_REF_HZ / 2400;     // half a cycle at 1200 Hz
  const SHORT = TAPE_REF_HZ / 4800;    // half a cycle at 2400 Hz
  const near = (a: number, b: number): void => { expect(Math.abs(a - b)).toBeLessThanOrEqual(1); };
  const float = (v: number): Uint8Array => new Uint8Array(new Float32Array([v]).buffer);

  /** The half-cycle lengths of the single pulse block `chunks` make. */
  async function halves(...chunks: UefChunk[]): Promise<number[]> {
    const blocks = await parseUEF(buildUef(chunks));
    expect(blocks).toHaveLength(1);
    return Array.from(csw(blocks[0]).pulses);
  }

  it('0111 is carrier, then a dummy byte &AA as ten bits, then carrier', async () => {
    // 2 cycles of 2400 Hz before, 3 after. &AA is sent LSB first as ten bits:
    // start 0, then 0 1 0 1 0 1 0 1, then stop 1. A 0 is one cycle at 1200 Hz,
    // a 1 two cycles at 2400 Hz.
    const p = await halves(chunk(0x0111, 2, 0, 3, 0));
    const expected = [
      ...Array(4).fill(SHORT),
      ...[0, 0, 1, 0, 1, 0, 1, 0, 1, 1].flatMap(b => (b ? Array(4).fill(SHORT) : [LONG, LONG])),
      ...Array(6).fill(SHORT),
    ];
    expect(p).toHaveLength(expected.length);
    p.forEach((v, i) => near(v, expected[i]));
  });

  it('0111 also reads the five-byte form with the dummy byte written out', async () => {
    const four = await halves(chunk(0x0111, 2, 0, 3, 0));
    const five = await halves(chunk(0x0111, 2, 0, 0xAA, 3, 0));
    expect(five).toEqual(four);
  });

  it('0113 changes the base frequency: carrier at 3000 Hz has 1/6000 s half-cycles and gaps scale with it', async () => {
    const p = await halves({ id: 0x0113, data: float(1500) }, chunk(0x0110, 3, 0));
    expect(p).toHaveLength(6);
    p.forEach(v => near(v, TAPE_REF_HZ / 6000));
    // Integer gap n lasts n / (2 x base) seconds: 3000 / (2 x 1500) = 1 s.
    const blocks = await parseUEF(buildUef([{ id: 0x0113, data: float(1500) }, chunk(0x0112, 0xB8, 0x0B)]));
    expect(blocks.map(b => b.kind === 'pause' ? b.duration : -1)).toEqual([1000]);
  });

  it('0104 with a negative stop count sends the stop bits and then one short wave per packet', async () => {
    const plain = await halves(chunk(0x0104, 8, 0x4E, 1, 0x00));
    const wave = await halves(chunk(0x0104, 8, 0x4E, 0xFF, 0x00));       // -1
    expect(wave).toHaveLength(plain.length + 2);
    expect(wave.slice(0, plain.length)).toEqual(plain);
    near(wave[wave.length - 2], SHORT);
    near(wave[wave.length - 1], SHORT);
  });

  describe('0114 security cycles', () => {
    // 3 cycles, most significant bit first: 0 = a cycle at the base frequency,
    // 1 = one at twice it. 0b010 -> slow, fast, slow.
    const cycles = (first: string, last: string, count = 3, bits = 0b01000000): UefChunk =>
      chunk(0x0114, count & 0xFF, (count >> 8) & 0xFF, count >> 16, first.charCodeAt(0), last.charCodeAt(0), bits);

    it('plays a slow or fast cycle for each bit, eight to a byte from the top', async () => {
      const p = await halves(cycles('W', 'W'));
      expect(p).toHaveLength(6);
      [LONG, LONG, SHORT, SHORT, LONG, LONG].forEach((e, i) => near(p[i], e));
      const nine = await halves(chunk(0x0114, 9, 0, 0, 0x57, 0x57, 0xFF, 0x80));   // 8 fast, then a fast
      expect(nine).toHaveLength(18);
      nine.forEach(v => near(v, SHORT));
    });

    it('P as the first flag replaces the first cycle with a single pulse', async () => {
      const p = await halves(cycles('P', 'W'));
      expect(p).toHaveLength(5);
      [LONG, SHORT, SHORT, LONG, LONG].forEach((e, i) => near(p[i], e));
    });

    it('P as the last flag replaces the last cycle with a single pulse', async () => {
      const p = await halves(cycles('W', 'P'));
      expect(p).toHaveLength(5);
      [LONG, LONG, SHORT, SHORT, LONG].forEach((e, i) => near(p[i], e));
    });

    it('a single cycle takes only one pulse, whichever flag asks for it', async () => {
      expect(await halves(cycles('P', 'W', 1))).toHaveLength(1);
      expect(await halves(cycles('W', 'P', 1))).toHaveLength(1);
    });

    it('stops at the data it has when the count is larger, and plays nothing for a count of zero', async () => {
      expect(await halves(cycles('W', 'W', 100))).toHaveLength(16);
      expect(await parseUEF(buildUef([cycles('W', 'W', 0)]))).toEqual([]);
    });

    it('is shown as tone', async () => {
      const blocks = await parseUEF(buildUef([cycles('W', 'W')]));
      expect(csw(blocks[0]).role).toBe('tone');
    });
  });

  it('0115 phase change, 0120 position markers, 0130/0131 tape information and other chunks leave the tape as it was', async () => {
    const plain = await parseUEF(buildUef([chunk(0x0110, 4, 0), chunk(0x0100, 0x41)]));
    const noisy = await parseUEF(buildUef([
      chunk(0x0000, 0x45, 0x00),
      chunk(0x0115, 0xB4, 0x00),                                   // 180 degrees
      chunk(0x0110, 4, 0),
      chunk(0x0120, 0x45, 0x64, 0x69, 0x74, 0x6F, 0x72, 0x00),     // "Editor"
      chunk(0x0115, 0x00, 0x00),                                   // 0 degrees
      chunk(0x0130, 0x01, 0x01, 0x01),
      chunk(0x0131, 0x00, 0x00, 0x41, 0x00),
      chunk(0x0100, 0x41),
      chunk(0x0005, 0x01),
    ]));
    expect(noisy.map(b => b.kind)).toEqual(plain.map(b => b.kind));
    const a = noisy.map(b => (b.kind === 'csw' ? Array.from(b.pulses) : []));
    const b = plain.map(x => (x.kind === 'csw' ? Array.from(x.pulses) : []));
    expect(a).toEqual(b);
  });
});
