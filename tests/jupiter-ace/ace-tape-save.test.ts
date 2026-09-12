/**
 * Recovering a SAVE from the MIC line.
 *
 * The expected waveform is the ROM's own, from the SAVE routine at
 * 0x1820-0x189A: 2011T pilot half-cycles (8192 per header, 1024 per data
 * block), 601T then 791T sync, and two equal half-cycles of 801T or 1591T per
 * bit, MSB first. The edge streams below are built from those figures and not
 * from anything the decoder does, and the decoded .tap is checked by feeding
 * it back through the loader's own parser.
 */

import { describe, it, expect } from 'vitest';
import {
  AceTapeRecorder, decodeAceSaveBlocks, decodeAceSaveToTap,
} from '@/machines/jupiter-ace/ace-tape-save.ts';
import { parseAceTap, ACE_TAPE_HEADER_CHUNK } from '@/machines/jupiter-ace/ace-tape.ts';
import { JupiterAceMachine } from '@/machines/jupiter-ace/ace-machine.ts';
import type { DataBlock } from '@/media/tape/tap.ts';

const PILOT_T = 2011;
const SYNC1_T = 601;
const SYNC2_T = 791;
const BIT0_T = 801;
const BIT1_T = 1591;

/** The edges the ROM writes for one block: leader, sync, then the bytes. */
function blockEdges(flag: number, chunk: number[], leaderEdges: number): number[] {
  const edges: number[] = [];
  for (let i = 0; i < leaderEdges; i++) edges.push(PILOT_T);
  edges.push(SYNC1_T, SYNC2_T);
  for (const byte of [flag, ...chunk]) {
    for (let bit = 7; bit >= 0; bit--) {
      const width = (byte >> bit) & 1 ? BIT1_T : BIT0_T;
      edges.push(width, width);   // two half-cycles per bit
    }
  }
  return edges;
}

function aceHeaderChunk(name: string, length: number): number[] {
  const h = new Uint8Array(ACE_TAPE_HEADER_CHUNK).fill(0x20);
  h[0] = 0;
  for (let i = 0; i < name.length; i++) h[1 + i] = name.charCodeAt(i);
  h[11] = length & 0xFF;
  h[12] = (length >> 8) & 0xFF;
  h[13] = 15441 & 0xFF;
  h[14] = (15441 >> 8) & 0xFF;
  for (let i = 15; i < 25; i++) h[i] = 0;
  let xor = 0;
  for (let i = 0; i < 25; i++) xor ^= h[i];
  h[25] = xor;
  return Array.from(h);
}

describe('AceTapeRecorder', () => {
  it('times transitions and ignores a write that does not move the line', () => {
    const r = new AceTapeRecorder();
    r.observe(0, 0);        // already low: not an edge
    r.observe(1, 1000);     // first transition starts the clock
    r.observe(1, 1500);     // unchanged
    r.observe(0, 1801);     // 801T half-cycle
    r.observe(1, 2602);     // another 801T
    expect(r.edges).toEqual([801, 801]);
  });

  it('does not treat a read clearing an already-low line as an edge', () => {
    // Every ULA read drops MIC, and the ROM reads mid-SAVE to check BREAK.
    const r = new AceTapeRecorder();
    r.observe(1, 0);
    r.observe(0, 801);
    r.observe(0, 900);      // the break-check read
    r.observe(0, 1000);
    r.observe(1, 1602);
    expect(r.edges).toEqual([801, 801]);
  });

  it('starts empty and clears on reset', () => {
    const r = new AceTapeRecorder();
    expect(r.hasRecording).toBe(false);
    r.observe(1, 0);
    for (let i = 1; i <= 200; i++) r.observe(i & 1, i * PILOT_T);
    expect(r.hasRecording).toBe(true);
    r.reset();
    expect(r.edges).toEqual([]);
    expect(r.hasRecording).toBe(false);
  });
});

describe('AceTapeService.recordedBytes', () => {
  function machine(): JupiterAceMachine {
    const m = new JupiterAceMachine('jupiter-ace', null);
    m.start = async () => {};   // headless: no AudioContext / rAF
    return m;
  }

  /** Drive an edge stream into the recorder the way the port handler does. */
  function feed(m: JupiterAceMachine, edges: number[]): void {
    let t = 0;
    let level = 1;
    m.tapeRecorder.observe(level, t);   // the first transition starts the clock
    for (const width of edges) {
      t += width;
      level ^= 1;
      m.tapeRecorder.observe(level, t);
    }
  }

  it('is null until the machine has written to the cassette port', () => {
    const m = machine();
    expect(m.services.tape.recordedBytes()).toBeNull();
    m.destroy();
  });

  it('hands back a .tap named after the file the machine saved', () => {
    const m = machine();
    const header = aceHeaderChunk('MiXeD', 4);
    feed(m, [
      ...blockEdges(0x00, header, 8192),
      ...blockEdges(0xFF, [1, 2, 3, 4, 1 ^ 2 ^ 3 ^ 4], 1024),
    ]);
    const saved = m.services.tape.recordedBytes();
    expect(saved).not.toBeNull();
    // Named exactly as stored — the Ace's own LOAD compares it literally.
    expect(saved!.filename).toBe('MiXeD.tap');
    const parsed = parseAceTap(saved!.data);
    expect(parsed.length).toBe(2);
    expect((parsed[0] as DataBlock).flag).toBe(0x00);
    expect((parsed[1] as DataBlock).flag).toBe(0xFF);
    m.destroy();
  });

  it('is offered by the descriptor as a Save-menu entry', () => {
    const m = machine();
    expect(m.descriptor.ui.saveMenu).toContain('tape-tap');
    m.destroy();
  });
});

describe('decoding a captured SAVE', () => {
  const header = aceHeaderChunk('SAVED', 4);
  const data = [1, 2, 3, 4, 1 ^ 2 ^ 3 ^ 4];

  it('reads back the flag and chunk of each block', () => {
    const edges = [
      ...blockEdges(0x00, header, 8192),
      ...blockEdges(0xFF, data, 1024),
    ];
    const blocks = decodeAceSaveBlocks(edges);
    expect(blocks.length).toBe(2);
    expect(blocks[0].flag).toBe(0x00);
    expect(blocks[0].chunk).toEqual(header);
    expect(blocks[1].flag).toBe(0xFF);
    expect(blocks[1].chunk).toEqual(data);
  });

  it('produces a .tap the loader parses back into the same pair', () => {
    const edges = [
      ...blockEdges(0x00, header, 8192),
      ...blockEdges(0xFF, data, 1024),
    ];
    const tap = decodeAceSaveToTap(edges);
    expect(tap).not.toBeNull();
    const parsed = parseAceTap(tap!);
    expect(parsed.length).toBe(2);
    expect((parsed[0] as DataBlock).flag).toBe(0x00);
    expect(Array.from((parsed[0] as DataBlock).data)).toEqual(header);
    expect((parsed[1] as DataBlock).flag).toBe(0xFF);
    expect(Array.from((parsed[1] as DataBlock).data)).toEqual(data);
  });

  it('ignores port traffic that arrives without a leader', () => {
    // BEEP writes A = D, so bit 3 flickers at whatever rate the tone needs.
    // Those edges carry no leader and must not decode into a block.
    const beep: number[] = [];
    for (let i = 0; i < 400; i++) beep.push(300);
    expect(decodeAceSaveBlocks(beep)).toEqual([]);
    expect(decodeAceSaveToTap(beep)).toBeNull();
  });

  it('still finds a block that follows a burst of beeping', () => {
    const beep = Array.from({ length: 400 }, () => 300);
    const edges = [...beep, ...blockEdges(0x00, header, 8192)];
    const blocks = decodeAceSaveBlocks(edges);
    expect(blocks.length).toBe(1);
    expect(blocks[0].chunk).toEqual(header);
  });
});
