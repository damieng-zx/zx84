/**
 * MSX pulse-level cassette: the .cas -> FSK synthesis, TZX block 0x4B (MSX
 * .tsx tapes), and the cassette input on PSG register 14 bit 7.
 *
 * Signal expectations are from the MSX cassette standard as the BIOS writes it
 * at 1200 baud: a 0 bit is one cycle of 1200 Hz, a 1 bit two cycles of 2400 Hz;
 * a byte is a 0 start bit, eight data bits LSb first, then two 1 stop bits;
 * blocks are led by 2400 Hz header tone (long 15360 cycles before a file
 * header, short 3840 before data). (The real-BIOS comparison lives in
 * msx-cassette-real-bios.test.ts.)
 */
import { describe, it, expect } from 'vitest';
import { casToPulseBlocks, CAS_HEADER } from '@/media/tape/cas.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { TAPE_REF_HZ, type CswBlock } from '@/media/tape/tap.ts';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';

const HALF_2400 = TAPE_REF_HZ / 4800;     // 729.17 T at the 3.5 MHz reference
const HALF_1200 = TAPE_REF_HZ / 2400;     // 1458.33 T

/** A .cas: ID + 16-byte BASIC file header + ID + data bytes. */
function cas(data: number[]): Uint8Array {
  const header = [0xD3, 0xD3, 0xD3, 0xD3, 0xD3, 0xD3, 0xD3, 0xD3, 0xD3, 0xD3, 0x54, 0x45, 0x53, 0x54, 0x20, 0x20];
  return Uint8Array.from([...CAS_HEADER, ...header, ...CAS_HEADER, ...data]);
}

/** Decode a pulse run (half-cycle lengths in reference T-states) back into bytes
 *  after its header tone. Returns the bytes and the number of header half-cycles. */
function demodulate(pulses: Uint32Array): { header: number; bytes: number[] } {
  // pulses[0] is the lead-in silence. Half-cycles shorter than ~1000 T are 2400 Hz.
  let i = 1;
  while (pulses[i] < 1000) i++;
  const header = i - 1;
  // The first 1200 Hz half-cycle starts the first start bit; walk bit cells.
  const bytes: number[] = [];
  const bit = (): number => {
    if (pulses[i] < 1000) { i += 4; return 1; }      // 2 cycles = 4 halves
    i += 2; return 0;                                 // 1 cycle = 2 halves
  };
  while (i < pulses.length) {
    if (bit() !== 0) throw new Error(`no start bit at ${i}`);
    let v = 0;
    for (let k = 0; k < 8; k++) v |= bit() << k;
    if (bit() !== 1 || bit() !== 1) throw new Error(`bad stop bits at ${i}`);
    bytes.push(v);
  }
  return { header, bytes };
}

describe('casToPulseBlocks', () => {
  const blocks = casToPulseBlocks(cas([0x00, 0xFF, 0x55, 0xAA])) as CswBlock[];

  it('makes one pulse block per .cas block', () => {
    expect(blocks).toHaveLength(2);
    expect(blocks.every(b => b.kind === 'csw')).toBe(true);
    expect(blocks[0].label).toBe('Header "TEST"');
    expect(blocks[1].label).toBe('Data');
  });

  it('leads a file header with 15360 cycles of 2400 Hz and data with 3840', () => {
    expect(demodulate(blocks[0].pulses).header).toBe(15360 * 2);
    expect(demodulate(blocks[1].pulses).header).toBe(3840 * 2);
  });

  it('encodes every byte as a start bit, eight bits LSb first and two stop bits', () => {
    expect(demodulate(blocks[1].pulses).bytes).toEqual([0x00, 0xFF, 0x55, 0xAA]);
    expect(demodulate(blocks[0].pulses).bytes).toEqual([0xD3, 0xD3, 0xD3, 0xD3, 0xD3, 0xD3, 0xD3, 0xD3, 0xD3, 0xD3, 0x54, 0x45, 0x53, 0x54, 0x20, 0x20]);
  });

  it('times the half-cycles at 2400 Hz and 1200 Hz to within one reference T-state', () => {
    for (const block of blocks) {
      const p = block.pulses;
      for (let i = 1; i < p.length; i++) {
        const want = p[i] < 1000 ? HALF_2400 : HALF_1200;
        expect(Math.abs(p[i] - want)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps long runs exact: rounding error does not accumulate over a block', () => {
    // 15360 header cycles at 2400 Hz last exactly 6.4 s.
    const header = blocks[0].pulses;
    let sum = 0;
    for (let i = 1; i <= 15360 * 2; i++) sum += header[i];
    expect(Math.abs(sum - 6.4 * TAPE_REF_HZ)).toBeLessThanOrEqual(1);
  });

  it('puts silence in front of each block', () => {
    expect(blocks[0].pulses[0]).toBe(TAPE_REF_HZ);            // 1 s before a header
    expect(blocks[1].pulses[0]).toBe(TAPE_REF_HZ / 2);        // 0.5 s before data
  });

  it('returns nothing for a file with no block IDs', () => {
    expect(casToPulseBlocks(new Uint8Array(32))).toEqual([]);
  });
});

/** A TZX with one Kansas City block (0x4B). */
function tsx(opts: { pause?: number; pilotLen?: number; pilotCount?: number; zero?: number; one?: number; zeroPulses?: number; onePulses?: number; cfg?: number; data: number[] }): Uint8Array {
  const body = [
    opts.pause ?? 0, 0,
    (opts.pilotLen ?? 729) & 0xFF, (opts.pilotLen ?? 729) >> 8,
    (opts.pilotCount ?? 4) & 0xFF, (opts.pilotCount ?? 4) >> 8,
    (opts.zero ?? 1458) & 0xFF, (opts.zero ?? 1458) >> 8,
    (opts.one ?? 729) & 0xFF, (opts.one ?? 729) >> 8,
    ((opts.zeroPulses ?? 2) << 4) | (opts.onePulses ?? 4),
    opts.cfg ?? 0x4C,                       // one leading 0 bit, one trailing 1 bit, LSb first
    ...opts.data,
  ];
  const len = body.length;
  return Uint8Array.from([
    ...Array.from('ZXTape!', c => c.charCodeAt(0)), 0x1A, 1, 20,
    0x4B, len & 0xFF, (len >> 8) & 0xFF, 0, 0, ...body,
  ]);
}

describe('TZX block 0x4B (MSX .tsx)', () => {
  it('turns pilot, start/data/stop bits and pulse counts into one pulse run', () => {
    const blocks = parseTZX(tsx({ data: [0xA5], cfg: 0x4C, pilotCount: 3 }));
    expect(blocks).toHaveLength(1);
    const p = (blocks[0] as CswBlock).pulses;
    // cfg 0x4C = 01 0 01 1 0 0: one leading 0 bit, one trailing 1 bit, LSb first.
    // Pilot: 3 pulses of 729. Then 0 bit (2 x 1458), 8 bits LSb first of 0xA5 = 1,0,1,0,0,1,0,1,
    // a 1 bit = 4 x 729, a 0 bit = 2 x 1458, then the trailing 1 bit.
    const want: number[] = [729, 729, 729];
    const bit = (b: number) => { if (b) want.push(729, 729, 729, 729); else want.push(1458, 1458); };
    bit(0);
    for (const b of [1, 0, 1, 0, 0, 1, 0, 1]) bit(b);
    bit(1);
    expect(Array.from(p)).toEqual(want);
  });

  it('reads MSb-first data when cfg bit 0 is set', () => {
    const lsb = (parseTZX(tsx({ data: [0x01], cfg: 0x00, pilotCount: 0 }))[0] as CswBlock).pulses;
    const msb = (parseTZX(tsx({ data: [0x01], cfg: 0x01, pilotCount: 0 }))[0] as CswBlock).pulses;
    // No leading/trailing bits: 0x01 LSb first is 1 then seven 0s; MSb first is seven 0s then 1.
    expect(lsb.length).toBe(4 + 7 * 2);
    expect(Array.from(lsb.slice(0, 4))).toEqual([729, 729, 729, 729]);
    expect(Array.from(msb.slice(-4))).toEqual([729, 729, 729, 729]);
  });

  it('treats a nibble of 0 in the pulse counts as 16', () => {
    const p = (parseTZX(tsx({ data: [0x00], cfg: 0x00, pilotCount: 0, zeroPulses: 0, onePulses: 0 }))[0] as CswBlock).pulses;
    expect(p.length).toBe(8 * 16);
  });

  it('appends the pause after the block', () => {
    const blocks = parseTZX(tsx({ data: [0x00], pause: 250 }));
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({ kind: 'pause', duration: 250 });
  });

  it('refuses a truncated block', () => {
    const bad = tsx({ data: [] });
    expect(() => parseTZX(bad.slice(0, bad.length - 4).fill(0, 0, 0))).toThrow();
  });
});

describe('cassette input on PSG register 14 bit 7', () => {
  const read14 = (m: MsxMachine): number => {
    m.cpu.portOut(0xA0, 14);
    return m.cpu.portIn(0xA2);
  };
  const motor = (m: MsxMachine, on: boolean): void => { m.ppi.writeC(on ? 0x00 : 0x10); };

  it('reads 1 (idle) with no tape, and joystick bits stay active-low high', () => {
    const m = new MsxMachine('hx-10', null);
    try {
      expect(read14(m)).toBe(0xFF);
    } finally { m.destroy(); }
  });

  it('keeps the joystick in bits 0-5 and does not leak the tape into them', () => {
    const m = new MsxMachine('hx-10', null);
    try {
      m.joystick.set('up', true);
      m.joystick.set('fire', true);
      expect(read14(m) & 0x7F).toBe(0x7F & ~0x01 & ~0x10);
      expect(read14(m) & 0x80).toBe(0x80);
    } finally { m.destroy(); }
  });

  it('follows the deck only while the motor relay (port C bit 4, low) is closed', () => {
    const m = new MsxMachine('hx-10', null);
    try {
      m.services.tape.mount(cas([0x42]), 't.cas');
      // Motor off (an 8255 powers up with port C clear, i.e. the relay closed,
      // until the BIOS opens it): the tape does not move, the line idles high.
      motor(m, false);
      m.cpu.tStates += 5_000_000;
      expect(read14(m) >> 7).toBe(1);
      expect(m.tape.position).toBe(0);
      motor(m, true);
      // The first block starts with 1 s of silence at the level the deck starts on
      // (low), then 2400 Hz: sample the line across the header and see it toggle.
      const seen = new Set<number>();
      let t = 0;
      while (t < 3_579_545 * 1.2) { m.cpu.tStates += 100; t += 100; seen.add(read14(m) >> 7); }
      expect(seen.has(0) && seen.has(1)).toBe(true);
      // Motor off again: the line returns to idle and the tape stops.
      motor(m, false);
      const pos = m.tape.position;
      m.cpu.tStates += 3_000_000;
      expect(read14(m) >> 7).toBe(1);
      expect(m.tape.position).toBe(pos);
    } finally { m.destroy(); }
  });

  it('plays 2400 Hz in the header: edges 208.3 us apart', () => {
    const m = new MsxMachine('hx-10', null);
    try {
      m.services.tape.mount(cas([0x42]), 't.cas');
      motor(m, true);
      m.cpu.tStates += Math.round(3_579_545 * 1.3);            // 1 s of silence + 0.3 s of header
      const edges: number[] = [];
      let last = read14(m) >> 7;
      for (let i = 0; i < 2000; i++) {
        m.cpu.tStates += 20;
        const v = read14(m) >> 7;
        if (v !== last) { edges.push(m.cpu.tStates); last = v; }
      }
      expect(edges.length).toBeGreaterThan(10);
      for (let i = 1; i < edges.length; i++) {
        const half = (edges[i] - edges[i - 1]) / 3_579_545;
        expect(Math.abs(half - 1 / 4800)).toBeLessThan(25e-6);   // within the 20 T sampling step
      }
    } finally { m.destroy(); }
  });

  it('with Fast ROM loading off the BIOS traps are not served', () => {
    const m = new MsxMachine('hx-10', null);
    try {
      m.services.tape.mount(cas([0x42]), 't.cas');
      expect(m.tapeFastRom).toBe(true);
      m.applySettings({ get: <T>(k: string, d: T) => (k === 'tape-instant-rom' ? false : d) as T });
      expect(m.tapeFastRom).toBe(false);
    } finally { m.destroy(); }
  });
});
