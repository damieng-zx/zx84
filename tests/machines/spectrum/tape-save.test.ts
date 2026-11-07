/**
 * Recording what a Spectrum SAVEs: MIC edges → .tzx.
 *
 * The expected waveform is the ROM's standard-speed encoding as the TZX
 * specification documents it for block 0x10 (pilot 2168T × 8063 before a
 * header / 3223 before data, sync 667T + 735T, a 0 bit two 855T half-cycles,
 * a 1 bit two 1710T half-cycles, MSB first). The synthetic pulse trains below
 * are built from those figures, never from the decoder, and the output is
 * checked byte-for-byte against the TZX block layout and by parsing it back
 * with zx84's own TZX reader. The round trip at the end runs the real 48K
 * ROM's SA-BYTES and LD-BYTES.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spectrumSaveToTzx } from '@/machines/spectrum/tape-save.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import type { CswBlock, DataBlock } from '@/media/tape/tap.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';

const PILOT = 2168, SYNC1 = 667, SYNC2 = 735, BIT0 = 855, BIT1 = 1710;
const ONE_SECOND = 3_500_000;

function romBlock(bytes: number[], pilotCount = bytes[0] < 0x80 ? 8063 : 3223): number[] {
  const p: number[] = [];
  for (let i = 0; i < pilotCount; i++) p.push(PILOT);
  p.push(SYNC1, SYNC2);
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const w = (byte >> bit) & 1 ? BIT1 : BIT0;
      p.push(w, w);
    }
  }
  return p;
}

const xor = (b: number[]): number => b.reduce((x, v) => x ^ v, 0);

/** A ROM header block for CODE "name" (flag, type 3, name, length, start, 32768), with checksum. */
function codeHeader(name: string, length: number, start: number): number[] {
  const h = [0x00, 0x03];
  for (let i = 0; i < 10; i++) h.push(i < name.length ? name.charCodeAt(i) : 0x20);
  h.push(length & 0xFF, length >> 8, start & 0xFF, start >> 8, 0x00, 0x80);
  h.push(xor(h));
  return h;
}

function dataBlock(payload: number[]): number[] {
  const d = [0xFF, ...payload];
  d.push(xor(d));
  return d;
}

describe('spectrumSaveToTzx (spec-built pulse trains)', () => {
  const header = codeHeader('demo', 4, 0x8000);
  const data = dataBlock([0x00, 0xFF, 0xA5, 0x3C]);
  const train = [...romBlock(header), ONE_SECOND, ...romBlock(data), ONE_SECOND / 2];

  it('writes ROM-speed blocks as TZX 0x10 standard blocks, laid out per the spec', () => {
    const out = spectrumSaveToTzx(train)!;
    const t = out.data;
    // "ZXTape!" 0x1A, version 1.20
    expect(Array.from(t.subarray(0, 10))).toEqual([0x5A, 0x58, 0x54, 0x61, 0x70, 0x65, 0x21, 0x1A, 1, 20]);
    // Block 1: 0x10, pause 1000 ms (the 1 s gap), length 19, the header bytes verbatim.
    expect(t[10]).toBe(0x10);
    expect(t[11] | (t[12] << 8)).toBe(1000);
    expect(t[13] | (t[14] << 8)).toBe(19);
    expect(Array.from(t.subarray(15, 34))).toEqual(header);
    // Block 2: 0x10, the trailing half second as its pause, 6 bytes.
    expect(t[34]).toBe(0x10);
    expect(t[35] | (t[36] << 8)).toBe(500);
    expect(t[37] | (t[38] << 8)).toBe(6);
    expect(Array.from(t.subarray(39, 45))).toEqual(data);
    expect(t.length).toBe(45);
  });

  it('names the file after the header', () => {
    expect(spectrumSaveToTzx(train)!.filename).toBe('demo.tzx');
  });

  it('parses back through the TZX reader as standard blocks', () => {
    const blocks = parseTZX(spectrumSaveToTzx(train)!.data);
    const dataBlocks = blocks.filter((b): b is DataBlock => b.kind === 'data');
    expect(dataBlocks.map(b => b.source)).toEqual(['standard', 'standard']);
    expect(Array.from(dataBlocks[0].rawBytes!)).toEqual(header);
    expect(Array.from(dataBlocks[1].rawBytes!)).toEqual(data);
  });

  it('reads the last bit when its second half-cycle never gets a closing edge', () => {
    // Drop the trailing silence and the final half-cycle: the line just stops moving.
    const cut = [...romBlock(data)];
    cut.pop();
    const blocks = parseTZX(spectrumSaveToTzx(cut)!.data).filter((b): b is DataBlock => b.kind === 'data');
    expect(Array.from(blocks[0].rawBytes!)).toEqual(data);
  });

  it('does not read the closing edge after the last bit as another bit', () => {
    // SA/LD-RET restores the border with MIC low ~945T after the last half-cycle.
    const blocks = parseTZX(spectrumSaveToTzx([...romBlock(data), 945, ONE_SECOND])!.data)
      .filter((b): b is DataBlock => b.kind === 'data');
    expect(blocks[0].source).toBe('standard');
    expect(Array.from(blocks[0].rawBytes!)).toEqual(data);
  });

  it('ignores clicks and short tones that are not saves', () => {
    const noise = [5000, 300, 90000, ...Array(100).fill(1000), ONE_SECOND];
    expect(spectrumSaveToTzx(noise)).toBeNull();
  });

  it('keeps a non-ROM (turbo) save as its exact pulse widths', () => {
    // 1000 pilot pulses of 1500T, sync 400/500, bits 500/1000T: no ROM block.
    const turbo: number[] = [];
    for (let i = 0; i < 1000; i++) turbo.push(1500);
    turbo.push(400, 500);
    for (let i = 0; i < 64; i++) turbo.push(i & 1 ? 1000 : 500, i & 1 ? 1000 : 500);
    const blocks = parseTZX(spectrumSaveToTzx([...turbo, ONE_SECOND])!.data);
    const csw = blocks.filter((b): b is CswBlock => b.kind === 'csw');
    expect(csw).toHaveLength(1);
    expect(Array.from(csw[0].pulses)).toEqual(turbo);
  });

  it('keeps an odd-length leader by falling back to a turbo block with the measured count', () => {
    const blocks = parseTZX(spectrumSaveToTzx(romBlock(data, 1000))!.data)
      .filter((b): b is DataBlock => b.kind === 'data');
    expect(blocks[0].source).toBe('turbo');
    expect(blocks[0].pilotCount).toBe(1000);
    expect(Array.from(blocks[0].rawBytes!)).toEqual(data);
  });

  it('keeps a partial last byte as used bits', () => {
    // flag + 3 bits 101 (no closing edge needed: add silence)
    const p = romBlock([0xFF], 3223);
    for (const bit of [1, 0, 1]) { const w = bit ? BIT1 : BIT0; p.push(w, w); }
    p.push(ONE_SECOND);
    const blocks = parseTZX(spectrumSaveToTzx(p)!.data).filter((b): b is DataBlock => b.kind === 'data');
    expect(blocks[0].source).toBe('turbo');
    expect(blocks[0].usedBits).toBe(3);
    expect(Array.from(blocks[0].rawBytes!)).toEqual([0xFF, 0b1010_0000]);
  });
});

// ── Round trip on the real 48K ROM ─────────────────────────────────────────

const ROM48 = [process.env.SPECTRUM_ROM_DIR, resolve(__dirname, '../../../mcp/.cache')]
  .filter((d): d is string => !!d)
  .map(d => resolve(d, '48.rom'))
  .find(p => existsSync(p));

const STUB = 0x8000;
const LOOP = STUB + 14;

/** LD IX,ix ; LD DE,de ; LD A,a ; SCF/AND A ; CALL routine ; JR $ */
function writeStub(s: Spectrum, routine: number, ix: number, de: number, a: number, load: boolean): void {
  const code = [
    0xDD, 0x21, ix & 0xFF, ix >> 8,
    0x11, de & 0xFF, de >> 8,
    0x3E, a,
    load ? 0x37 : 0xA7,                 // SCF (load) / AND A
    0xCD, routine & 0xFF, routine >> 8,
    0x00,                               // NOP
    0x18, 0xFE,                         // LOOP: JR $
  ];
  code.forEach((b, i) => s.memory.writeByte(STUB + i, b));
}

function runToLoop(s: Spectrum, maxFrames: number): void {
  s.cpu.pc = STUB;
  for (let f = 0; f < maxFrames && s.cpu.pc !== LOOP; f++) s.tick();
  expect(s.cpu.pc).toBe(LOOP);
}

describe.skipIf(!ROM48)('Spectrum SAVE → .tzx → LOAD on the real 48K ROM', { timeout: 60_000 }, () => {
  if (!ROM48) console.warn('48.rom not found (SPECTRUM_ROM_DIR or mcp/.cache): skipping the ROM round trip');

  function boot(): Spectrum {
    const s = new Spectrum('zx48k', null);
    s.loadROM(new Uint8Array(readFileSync(ROM48!)));
    s.reset();
    for (let f = 0; f < 150; f++) s.tick();
    return s;
  }

  const payload = Array.from({ length: 200 }, (_, i) => (i * 37 + 11) & 0xFF);
  // The 17 header bytes SAVE "roundtrip" CODE 40000,200 builds (SA-BYTES adds flag + checksum).
  const hdr = [0x03, ...Array.from('roundtrip ', c => c.charCodeAt(0)), 200, 0, 0x40, 0x9C, 0x00, 0x80];

  /** Run SA-BYTES for the header then the data, as SAVE does. */
  function save(s: Spectrum): void {
    hdr.forEach((b, i) => s.memory.writeByte(0x9000 + i, b));
    payload.forEach((b, i) => s.memory.writeByte(40000 + i, b));
    writeStub(s, 0x04C2, 0x9000, 17, 0x00, false);
    runToLoop(s, 600);
    writeStub(s, 0x04C2, 40000, payload.length, 0xFF, false);
    runToLoop(s, 600);
  }

  it('records SA-BYTES as standard blocks, and reset forgets them', () => {
    const s = boot();
    try {
      save(s);
      const rec = s.services.tape!.recordedBytes!()!;
      expect(rec.filename).toBe('roundtrip.tzx');
      const blocks = parseTZX(rec.data).filter((b): b is DataBlock => b.kind === 'data');
      // The ROM's leader lengths and bit timings are the standard ones: both become 0x10 blocks.
      expect(blocks.map(b => b.source)).toEqual(['standard', 'standard']);
      expect(Array.from(blocks[0].rawBytes!)).toEqual([0x00, ...hdr, xor([0x00, ...hdr])]);
      expect(Array.from(blocks[1].rawBytes!)).toEqual(dataBlock(payload));
      s.reset();
      expect(s.services.tape!.recordedBytes!()).toBeNull();
    } finally { s.destroy(); }
  });

  it.each([false, true])('loads the recording back through LD-BYTES (ROM trap %s)', async (trap) => {
    const sv = boot();
    let rec: { data: Uint8Array; filename: string };
    try { save(sv); rec = sv.services.tape!.recordedBytes!()!; } finally { sv.destroy(); }

    const s = boot();
    try {
      s.tapeFastRom = trap;
      expect(await s.services.tape!.mountBytes(rec.data, rec.filename)).toBe(true);
      s.services.tape!.play();
      writeStub(s, 0x0556, 0xA000, 17, 0x00, true);
      runToLoop(s, 800);
      expect(s.cpu.f & 1).toBe(1);                         // carry: loaded, checksum good
      writeStub(s, 0x0556, 0xB000, payload.length, 0xFF, true);
      runToLoop(s, 800);
      expect(s.cpu.f & 1).toBe(1);
      expect(Array.from({ length: 17 }, (_, i) => s.memory.readByte(0xA000 + i))).toEqual(hdr);
      expect(Array.from({ length: payload.length }, (_, i) => s.memory.readByte(0xB000 + i))).toEqual(payload);
    } finally { s.destroy(); }
  });
});
