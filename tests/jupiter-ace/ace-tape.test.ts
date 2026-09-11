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
    expect(d.bit0Pulse).toBe(856);
    expect(d.bit1Pulse).toBe(1707);
    expect(h.pilotCount).toBe(8192);
    expect(d.pilotCount).toBe(1024);
    // Through the deck's pulseScale these land back on the ROM's own widths.
    const scale = 3_250_000 / 3_500_000;
    expect(Math.round(h.pilotPulse * scale)).toBe(2011);
    expect(Math.round(h.syncPulse1 * scale)).toBe(601);
    expect(Math.round(h.syncPulse2 * scale)).toBe(791);
    expect(Math.round(d.bit0Pulse * scale)).toBe(795);
    expect(Math.round(d.bit1Pulse * scale)).toBe(1585);
  });

  it('stops cleanly on a truncated chunk', () => {
    const good = tap([aceHeader({ type: 0, name: 'OK', length: 1, start: 15441 })]);
    const blocks = parseAceTap(new Uint8Array([...good, 0x05, 0x00, 1, 2]));
    expect(blocks.length).toBe(1);   // the trailing chunk claims 5 bytes, 2 remain
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
});
