/**
 * Ace tape format (jupiter-ace.co.uk doc_AceTapeFormat, MAME ace_tap.cpp).
 *
 * Ace .tap chunks are [len16][bytes] with NO flag and NO checksum of their
 * own: chunk length 0x001A = header (25 payload bytes + the loader's
 * checksum), anything else = data. The flag the ROM receives is synthesized
 * (0x00/0xFF) and the chunk bytes follow verbatim — that synthesized stream
 * is what DataBlock.rawBytes must carry.
 *
 * Header payload: type byte (0 = dictionary, non-zero = bytes), 10-byte
 * space-padded name, LE length, LE start address (15441 for dictionaries),
 * then five LE words echoing FORTH sysvars.
 */

import { describe, it, expect } from 'vitest';
import {
  parseAceTapeHeader, parseAceTap, tagAceTapeFiles, ACE_TAPE_HEADER_CHUNK,
} from '@/machines/jupiter-ace/ace-tape.ts';
import type { DataBlock, TapeBlock } from '@/media/tape/tap.ts';
import { JupiterAceMachine } from '@/machines/jupiter-ace/ace-machine.ts';

/** Build a 26-byte Ace header chunk (25 payload bytes + checksum byte). */
function aceHeader(opts: { type: number; name: string; length: number; start: number }): Uint8Array {
  const h = new Uint8Array(ACE_TAPE_HEADER_CHUNK).fill(0x20);
  h[0] = opts.type;
  for (let i = 0; i < opts.name.length; i++) h[1 + i] = opts.name.charCodeAt(i);
  h[11] = opts.length & 0xFF;
  h[12] = (opts.length >> 8) & 0xFF;
  h[13] = opts.start & 0xFF;
  h[14] = (opts.start >> 8) & 0xFF;
  h[25] = 0xAA;   // checksum — parsed past, not validated
  return h;
}

function dataBlock(flag: number, payload: Uint8Array): DataBlock {
  return {
    kind: 'data', flag, data: payload,
    pause: 1000, pilotPulse: 2168, syncPulse1: 667, syncPulse2: 735,
    bit0Pulse: 855, bit1Pulse: 1710, pilotCount: 8063, usedBits: 8, source: 'tap',
  };
}

describe('parseAceTapeHeader', () => {
  it('parses a dictionary header: type 0, trimmed name, LE length and start', () => {
    // Dictionary "HI", 100 bytes, start 15441 (the documented dictionary address).
    const h = aceHeader({ type: 0, name: 'HI', length: 100, start: 15441 });
    const f = parseAceTapeHeader(h);
    expect(f).toEqual({ name: 'HI', isDictionary: true, length: 100, start: 15441 });
  });

  it('parses a bytes header: any non-zero type byte', () => {
    const h = aceHeader({ type: 32, name: 'CODE', length: 0x1234, start: 0x4000 });
    const f = parseAceTapeHeader(h);
    expect(f).toEqual({ name: 'CODE', isDictionary: false, length: 0x1234, start: 0x4000 });
  });

  it('keeps a full 10-character name and decodes a 0xFFFF length', () => {
    const h = aceHeader({ type: 0, name: 'ABCDEFGHIJ', length: 0xFFFF, start: 0xABCD });
    const f = parseAceTapeHeader(h);
    expect(f?.name).toBe('ABCDEFGHIJ');
    expect(f?.length).toBe(0xFFFF);
    expect(f?.start).toBe(0xABCD);
  });

  it('accepts a checksum-less 25-byte dump but rejects other sizes', () => {
    const h26 = aceHeader({ type: 0, name: 'X', length: 1, start: 15441 });
    expect(parseAceTapeHeader(h26.subarray(0, 25))).not.toBeNull();
    expect(parseAceTapeHeader(h26.subarray(0, 17))).toBeNull();   // Spectrum header
    expect(parseAceTapeHeader(h26.subarray(0, 24))).toBeNull();
    expect(parseAceTapeHeader(new Uint8Array(27))).toBeNull();
  });
});

describe('parseAceTap — the flag-less chunk container', () => {
  function tap(chunks: Uint8Array[]): Uint8Array {
    const out: number[] = [];
    for (const c of chunks) out.push(c.length & 0xFF, (c.length >> 8) & 0xFF, ...c);
    return new Uint8Array(out);
  }

  it('synthesizes the flag from the chunk length and plays chunk bytes verbatim', () => {
    const header = aceHeader({ type: 0, name: 'DEMO', length: 3, start: 15441 });
    const data = Uint8Array.from([1, 2, 3, 0x55]);   // payload + checksum, no flag
    const blocks = parseAceTap(tap([header, data]));
    expect(blocks.length).toBe(2);

    const h = blocks[0] as DataBlock;
    expect(h.flag).toBe(0x00);                       // 0x001A chunk = header
    expect(h.data.length).toBe(26);
    // rawBytes = synthesized flag + chunk verbatim (27 bytes on the wire).
    expect(h.rawBytes?.length).toBe(27);
    expect(h.rawBytes?.[0]).toBe(0x00);
    expect(h.rawBytes?.[1]).toBe(0x00);              // dictionary type byte
    expect(Array.from(h.rawBytes!.subarray(1))).toEqual(Array.from(header));

    const d = blocks[1] as DataBlock;
    expect(d.flag).toBe(0xFF);                       // any other length = data
    expect(d.rawBytes?.[0]).toBe(0xFF);
    expect(Array.from(d.rawBytes!.subarray(1))).toEqual(Array.from(data));
  });

  it('carries the Ace pulse geometry from the ROM SAVE routine', () => {
    // The ROM's SAVE loop (0x1820-0x189A) emits 2011T pilot half-cycles
    // (8192 per header, 1024 per data block), 601T + 791T sync, and two
    // equal half-cycles of 795T / 1585T per bit. These are the deck's
    // 3.5MHz-referenced units; pulseScale maps them back to 3.25MHz.
    const blocks = parseAceTap(tap([
      aceHeader({ type: 0, name: 'A', length: 1, start: 15441 }),
      Uint8Array.from([1, 0xAA]),
    ]));
    const h = blocks[0] as DataBlock;
    const d = blocks[1] as DataBlock;
    expect(h.pilotPulse).toBe(2166);
    expect(h.syncPulse1).toBe(647);
    expect(h.syncPulse2).toBe(852);
    expect(d.bit0Pulse).toBe(863);
    expect(d.bit1Pulse).toBe(1713);
    expect(h.pilotCount).toBe(8192);
    expect(d.pilotCount).toBe(1024);
    // Through the deck's pulseScale these land back on the ROM's own widths.
    const scale = 3_250_000 / 3_500_000;
    expect(Math.round(h.pilotPulse * scale)).toBe(2011);
    expect(Math.round(h.syncPulse1 * scale)).toBe(601);
    expect(Math.round(h.syncPulse2 * scale)).toBe(791);
    expect(Math.round(d.bit0Pulse * scale)).toBe(801);
    expect(Math.round(d.bit1Pulse * scale)).toBe(1591);
  });

  it('treats the chunk after a header as data even when it is 26 bytes long', () => {
    // A 25-byte payload plus its checksum is a 0x001A chunk, the same length
    // as a header. Ace files are header-then-data pairs, so this is the data:
    // flag it 0x00 and the ROM, waiting with C = 0xFF, fails the flag test at
    // 0x18DC and goes back to hunting for a header that never comes.
    const blocks = parseAceTap(tap([
      aceHeader({ type: 0, name: 'X', length: 25, start: 15441 }),
      new Uint8Array(ACE_TAPE_HEADER_CHUNK).fill(7),
    ]));
    expect(blocks.length).toBe(2);
    expect((blocks[0] as DataBlock).flag).toBe(0x00);
    const data = blocks[1] as DataBlock;
    expect(data.flag).toBe(0xFF);
    expect(data.rawBytes?.[0]).toBe(0xFF);
    expect(data.pilotCount).toBe(1024);   // the short data-block pilot
  });

  it('starts a fresh pair on the chunk after the data block', () => {
    const header = aceHeader({ type: 0, name: 'A', length: 2, start: 15441 });
    const blocks = parseAceTap(tap([header, Uint8Array.from([1, 2, 3]), header]));
    expect(blocks.map(b => (b as DataBlock).flag)).toEqual([0x00, 0xFF, 0x00]);
  });

  it('stops cleanly on a truncated chunk', () => {
    const good = tap([aceHeader({ type: 0, name: 'OK', length: 1, start: 15441 })]);
    const blocks = parseAceTap(new Uint8Array([...good, 0x05, 0x00, 1, 2]));
    expect(blocks.length).toBe(1);   // the trailing chunk claims 5 bytes, 2 remain
  });
});

describe('tape widths derived from the ROM SAVE routine (0x1820-0x189A)', () => {
  /** DJNZ costs 13T per taken iteration and 8T on the final one. */
  const djnz = (count: number): number => (count - 1) * 13 + 8;
  const scale = 3_250_000 / 3_500_000;
  const played = (refT: number): number => Math.round(refT * scale);

  const blocks = parseAceTap(new Uint8Array([
    ACE_TAPE_HEADER_CHUNK, 0, ...aceHeader({ type: 0, name: 'A', length: 1, start: 15441 }),
    2, 0, 1, 0xAA,
  ]));
  const header = blocks[0] as DataBlock;
  const data = blocks[1] as DataBlock;

  it('pilot: the 0x1837 loop is 2011T per edge, 0x2000 / 0x400 edges long', () => {
    // LD B,97 (7) + DJNZ×0x97 + OUT (11) + XOR 08 (7) + INC L (4)
    // + JR NZ to 0x1843 (12) + JR NZ back to 0x1837 (12).
    const pilotEdge = 7 + djnz(0x97) + 11 + 7 + 4 + 12 + 12;
    expect(pilotEdge).toBe(2011);
    expect(played(header.pilotPulse)).toBe(pilotEdge);
    // HL counts up to zero from 0xE000 for a header, 0xFC00 for a data block.
    expect(header.pilotCount).toBe(0x10000 - 0xE000);
    expect(data.pilotCount).toBe(0x10000 - 0xFC00);
  });

  it('sync: 601T from the 0x1845 delay, then 791T from the 0x184C delay', () => {
    // Pilot-loop tail (XOR 7 + INC L 4 + JR NZ 7 + INC H 4 + JR NZ 7 = 29)
    // + LD B,2B (7) + DJNZ×0x2B + OUT (11).
    const sync1 = 29 + 7 + djnz(0x2B) + 11;
    // LD L,C (4) + LD BC,3B08 (10) + DJNZ×0x3B + LD A,C (4) + OUT (11).
    const sync2 = 4 + 10 + djnz(0x3B) + 4 + 11;
    expect(sync1).toBe(601);
    expect(sync2).toBe(791);
    expect(played(header.syncPulse1)).toBe(sync1);
    expect(played(header.syncPulse2)).toBe(sync2);
  });

  it("bits: the 0x185C loop gives ~801T for a '0' and ~1591T for a '1'", () => {
    // Between two OUTs: LD B,3A (7) + JP NZ (10) + LD A,C (4) + BIT 7,B (8)
    // + DJNZ×0x3A + OUT (11), plus the carry-set detour for a '1'
    // (JR NC not taken 7 + LD B,3D 7 + DJNZ×0x3D).
    const common = 7 + 10 + 4 + 8 + djnz(0x3A) + 11;
    const bit0 = common + 12;                          // JR NC taken
    const bit1 = common + 7 + 7 + djnz(0x3D);
    expect(bit0).toBe(801);
    expect(bit1).toBe(1591);
    // A 3.5MHz-referenced round trip costs at most a T either way.
    expect(Math.abs(played(data.bit0Pulse) - bit0)).toBeLessThanOrEqual(1);
    expect(Math.abs(played(data.bit1Pulse) - bit1)).toBeLessThanOrEqual(1);
  });
});

describe('played widths against the ROM loader filters (0x18A7-0x192C)', () => {
  // The sampler at 0x1915 polls the EAR every 59T (INC B, RET Z, LD A,7F,
  // IN, RRA, RET NC, XOR C, AND 10, JR Z) after a ~326T settle delay, with B
  // counting one per poll and a wrap to zero meaning "timed out". 0x1911
  // measures a whole CYCLE by calling 0x1915 twice and letting it fall
  // through, so the pilot filter (B based 0xB8, accept > 0xDF) and the
  // per-bit read (B based 0xC7, a 1 when > 0xE2) both span two edges; only
  // the sync search at 0x18C7 measures a single edge (B based 0xCF, exit
  // when <= 0xD8).
  const PASS_T = 59;
  const bAfter = (base: number, spanT: number, overheadT: number): number =>
    base + Math.floor((spanT - overheadT) / PASS_T);
  // The fixed work around the poll loop is ~790T per cycle and ~400T per
  // single edge; assert the classification over a generous range of it
  // rather than pinning a figure that hand-counting could get slightly off.
  const CYCLE_OVERHEAD = [700, 750, 800, 850, 900];
  const EDGE_OVERHEAD = [350, 400, 450];

  it('a 2011T pilot cycle is counted as pilot and never wraps B', () => {
    for (const overhead of CYCLE_OVERHEAD) {
      const b = bAfter(0xB8, 2 * 2011, overhead);
      expect(b).toBeGreaterThan(0xDF);
      expect(b).toBeLessThan(0x100);
    }
  });

  it('sync1 ends the pilot search but a pilot edge does not', () => {
    for (const overhead of EDGE_OVERHEAD) {
      expect(bAfter(0xCF, 601, overhead)).toBeLessThanOrEqual(0xD8);
      expect(bAfter(0xCF, 2011, overhead)).toBeGreaterThan(0xD8);
    }
  });

  it("reads a '0' cycle as 0 and a '1' cycle as 1, with margin", () => {
    for (const overhead of CYCLE_OVERHEAD) {
      expect(bAfter(0xC7, 2 * 801, overhead)).toBeLessThanOrEqual(0xE2 - 2);
      const one = bAfter(0xC7, 2 * 1591, overhead);
      expect(one).toBeGreaterThanOrEqual(0xE2 + 3);
      expect(one).toBeLessThan(0x100);
    }
  });

  it('a one-edge-per-bit waveform overflows B and never loads', () => {
    // Why the deck must not play a bit as a single wide pulse: two 2900T
    // edges make a 5800T cycle, which runs B past 0xFF from its 0xB8 base,
    // so 0x18BA times out instead of counting its 256 pilot cycles.
    for (const overhead of CYCLE_OVERHEAD) {
      expect(bAfter(0xB8, 2 * 2900, overhead)).toBeGreaterThanOrEqual(0x100);
    }
  });
});

describe('tagAceTapeFiles', () => {
  it('tags a header/data pair as LOAD "name" with the data child hidden behind it', () => {
    const blocks: TapeBlock[] = [
      dataBlock(0x00, aceHeader({ type: 0, name: 'HELLO', length: 100, start: 15441 })),
      dataBlock(0xFF, new Uint8Array(101)),
    ];
    tagAceTapeFiles(blocks);
    const lead = (blocks[0] as DataBlock).file;
    expect(lead).toEqual({
      name: 'HELLO', type: 'Dictionary', typeName: 'Dictionary',
      command: 'LOAD', size: 100, header: true,
    });
    const child = (blocks[1] as DataBlock).file;
    expect(child?.header).toBe(false);
    expect(child?.command).toBe('LOAD');
    expect(child?.size).toBe(101);
  });

  it('tags bytes files as BLOAD', () => {
    const blocks: TapeBlock[] = [
      dataBlock(0x00, aceHeader({ type: 32, name: 'CODE', length: 300, start: 30000 })),
      dataBlock(0xFF, new Uint8Array(301)),
    ];
    tagAceTapeFiles(blocks);
    expect((blocks[0] as DataBlock).file?.command).toBe('BLOAD');
    expect((blocks[0] as DataBlock).file?.typeName).toBe('Bytes');
  });

  it('leaves non-Ace blocks untouched (a 17-byte Spectrum header stays generic)', () => {
    const blocks: TapeBlock[] = [
      dataBlock(0x00, new Uint8Array(17)),
      dataBlock(0xFF, new Uint8Array(50)),
    ];
    tagAceTapeFiles(blocks);
    expect((blocks[0] as DataBlock).file).toBeUndefined();
    expect((blocks[1] as DataBlock).file).toBeUndefined();
  });

  it('tags a trailing header even when no data block follows', () => {
    const blocks: TapeBlock[] = [
      dataBlock(0x00, aceHeader({ type: 0, name: 'LAST', length: 5, start: 15441 })),
    ];
    tagAceTapeFiles(blocks);
    expect((blocks[0] as DataBlock).file?.header).toBe(true);
  });
});

describe('AceTapeService — mountBytes tags Ace pairs end to end', () => {
  function machine(): JupiterAceMachine {
    const m = new JupiterAceMachine('jupiter-ace', null);
    m.start = async () => {};
    return m;
  }

  /** Wrap chunks into an Ace .tap container ([len:2][chunk] per block). */
  function tap(chunks: Uint8Array[]): Uint8Array {
    const out: number[] = [];
    for (const c of chunks) {
      out.push(c.length & 0xFF, (c.length >> 8) & 0xFF, ...c);
    }
    return new Uint8Array(out);
  }

  it('mounting a TAP stamps the header and data blocks', async () => {
    const m = machine();
    const header = aceHeader({ type: 0, name: 'DEMO', length: 3, start: 15441 });
    const dataChunk = Uint8Array.from([1, 2, 3, 0x55]);   // payload + checksum

    const ok = await m.services.tape.mountBytes(tap([header, dataChunk]), 'demo.tap');
    expect(ok).toBe(true);

    // The pane's combined row comes from the shared TapeBlockInfo mapping.
    const info = m.services.tape.blocks[0];
    expect(info.label).toBe('LOAD "DEMO"');
    expect(info.detail).toBe('Dictionary · 3 bytes');
    // The raw blocks carry the pair markers for the combine view.
    expect((m.tape.blocks[0] as DataBlock).file?.header).toBe(true);
    expect((m.tape.blocks[1] as DataBlock).file?.header).toBe(false);
    m.destroy();
  });

  it('the mount message names the exact word to type', async () => {
    // The Ace compares tape filenames literally, so a user who cannot see the
    // stored name has no way to type it: "MiXeD" must come back verbatim.
    const m = machine();
    const header = aceHeader({ type: 0, name: 'MiXeD', length: 3, start: 15441 });
    const result = await m.services.media.mount(tap([header, Uint8Array.from([1, 2, 3, 0x55])]), 'demo.tap');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('LOAD MiXeD');
    m.destroy();
  });

  it('a bytes file is announced as BLOAD', async () => {
    const m = machine();
    const header = aceHeader({ type: 32, name: 'CODE', length: 3, start: 16384 });
    const result = await m.services.media.mount(tap([header, Uint8Array.from([1, 2, 3, 0x55])]), 'code.tap');
    expect(result.message).toContain('BLOAD CODE');
    m.destroy();
  });
});
