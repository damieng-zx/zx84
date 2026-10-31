/**
 * Recording what a CPC writes to cassette: PPI Port C bit 5 edges → .cdt.
 *
 * The expected record layout is the firmware guide's cassette manager
 * format: a leader of 2048 one bits, a zero sync bit, the sync character
 * (&2C header / &16 data), the data in 256-byte segments each followed by
 * the complement of its CRC-16/CCITT (big-endian), and a 32-one-bit trailer.
 * A bit is one cycle of two equal halves; a 1 is twice as long as a 0. The
 * synthetic trains are built from that description, the output is checked
 * against the TZX 0x11 block layout, and the real-firmware round trip at the
 * end runs CAS WRITE and then CAS READ on what was recorded.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpcSaveToCdt } from '@/machines/cpc/cpc-tape-save.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import type { DataBlock } from '@/media/tape/tap.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import type { CpcModel } from '@/machines/cpc/models.ts';

/** CRC-16/CCITT: poly 0x1021, initial 0xFFFF, MSB first. */
function crc16(bytes: number[]): number {
  let crc = 0xFFFF;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

/** One firmware record as it goes to tape: sync char, 256-byte segments
 *  (zero-padded) each with its complemented CRC, then the 4-byte trailer. */
function record(sync: number, data: number[]): number[] {
  const out = [sync];
  for (let s = 0; s < Math.max(1, Math.ceil(data.length / 256)); s++) {
    const seg = data.slice(s * 256, s * 256 + 256);
    while (seg.length < 256) seg.push(0);
    const crc = ~crc16(seg) & 0xFFFF;
    out.push(...seg, crc >> 8, crc & 0xFF);
  }
  out.push(0xFF, 0xFF, 0xFF, 0xFF);
  return out;
}

/** 1000 baud: a zero half is 333 µs = 1333 T-states of the 4 MHz Z80. */
const ZERO = 1333, ONE = 2667;

function recordPulses(bytes: number[]): number[] {
  const p: number[] = [];
  for (let i = 0; i < 4096; i++) p.push(ONE);
  p.push(ZERO, ZERO);
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const w = (byte >> bit) & 1 ? ONE : ZERO;
      p.push(w, w);
    }
  }
  return p;
}

function headerRecord(name: string): number[] {
  const h = Array(64).fill(0);
  for (let i = 0; i < name.length; i++) h[i] = name.charCodeAt(i);
  h[16] = 1;            // block number
  h[17] = 0xFF;         // last block
  h[18] = 2;            // binary file
  return record(0x2C, h);
}

describe('cpcSaveToCdt (spec-built pulse trains)', () => {
  const header = headerRecord('GAME');
  const data = record(0x16, [1, 2, 3, 4]);
  const train = [...recordPulses(header), 4_000_000, ...recordPulses(data), 2_000_000];

  it('writes each record as a TZX 0x11 turbo block in 3.5 MHz T-states', () => {
    const t = cpcSaveToCdt(train)!.data;
    expect(Array.from(t.subarray(0, 10))).toEqual([0x5A, 0x58, 0x54, 0x61, 0x70, 0x65, 0x21, 0x1A, 1, 20]);
    expect(t[10]).toBe(0x11);
    const w = (o: number): number => t[o] | (t[o + 1] << 8);
    // 2667 and 1333 4 MHz T-states are 2334 and 1166 at 3.5 MHz.
    expect(w(11)).toBe(2334);             // pilot
    expect(w(13)).toBe(1166);             // sync 1
    expect(w(15)).toBe(1166);             // sync 2
    expect(w(17)).toBe(1166);             // bit 0
    expect(w(19)).toBe(2334);             // bit 1
    expect(w(21)).toBe(4096);             // pilot pulses
    expect(t[23]).toBe(8);                // used bits
    expect(w(24)).toBe(1000);             // the one-second gap as the pause
    expect(t[26] | (t[27] << 8) | (t[28] << 16)).toBe(header.length);
    expect(Array.from(t.subarray(29, 29 + header.length))).toEqual(header);
  });

  it('names the file from the header record', () => {
    expect(cpcSaveToCdt(train)!.filename).toBe('GAME.cdt');
  });

  it('parses back as two turbo blocks with the records verbatim', () => {
    const blocks = parseTZX(cpcSaveToCdt(train)!.data).filter((b): b is DataBlock => b.kind === 'data');
    expect(blocks.map(b => Array.from(b.rawBytes!))).toEqual([header, data]);
  });

  it('follows the speed set by the leader (2000 baud)', () => {
    const fast = recordPulses(data).map(w => w / 2);
    const blocks = parseTZX(cpcSaveToCdt(fast)!.data).filter((b): b is DataBlock => b.kind === 'data');
    expect(Array.from(blocks[0].rawBytes!)).toEqual(data);
    expect(blocks[0].pilotPulse).toBe(1167);
  });

  it('records nothing for a line that never carries a leader', () => {
    expect(cpcSaveToCdt([ONE, ZERO, ONE, 4_000_000, ...Array(200).fill(ZERO)])).toBeNull();
  });
});

// ── Round trip on real firmware ──────────────────────────────────────────

const CACHE = [process.env.CPC_ROM_DIR, resolve(__dirname, '../../mcp/.cache')]
  .filter((d): d is string => !!d)
  .find(d => existsSync(resolve(d, 'os464.rom')));
const FIRMWARE: Record<string, [string, string]> = {
  cpc464: ['os464.rom', 'basic1-0.rom'],
  cpc6128: ['os6128.rom', 'basic1-1.rom'],
};
const haveRoms = !!CACHE && Object.values(FIRMWARE).flat().every(r => existsSync(resolve(CACHE, r)));

const STUB = 0x4000;
const LOOP = STUB + 12;

/** LD HL,hl ; LD DE,de ; LD A,a ; CALL routine ; NOP ; JR $ */
function runStub(m: CpcMachine, routine: number, hl: number, de: number, a: number): void {
  const code = [0x21, hl & 0xFF, hl >> 8, 0x11, de & 0xFF, de >> 8, 0x3E, a,
    0xCD, routine & 0xFF, routine >> 8, 0x00, 0x18, 0xFE];
  code.forEach((b, i) => m.memory.writeByte(STUB + i, b));
  m.cpu.pc = STUB;
  for (let f = 0; f < 3000 && m.cpu.pc !== LOOP; f++) m.tick();
  expect(m.cpu.pc).toBe(LOOP);
}

const CAS_WRITE = 0xBC9E;
const CAS_READ = 0xBCA1;

describe.skipIf(!haveRoms)('CPC CAS WRITE → .cdt → CAS READ (real firmware)', { timeout: 120_000 }, () => {
  if (!haveRoms) console.warn('CPC firmware ROMs not found (CPC_ROM_DIR or mcp/.cache): skipping');

  function boot(model: string): CpcMachine {
    const m = new CpcMachine(model as CpcModel, null);
    const [os, basic] = FIRMWARE[model];
    m.memory.loadRoms(new Uint8Array(readFileSync(resolve(CACHE!, os))),
      new Uint8Array(readFileSync(resolve(CACHE!, basic))));
    m.reset();
    for (let f = 0; f < 150; f++) m.tick();
    return m;
  }

  const header = Array.from({ length: 64 }, (_, i) => (i < 4 ? 'SAVE'.charCodeAt(i) : i));
  const payload = Array.from({ length: 300 }, (_, i) => (i * 29 + 5) & 0xFF);

  function save(model: string): { data: Uint8Array; filename: string } {
    const m = boot(model);
    try {
      header.forEach((b, i) => m.memory.writeByte(0x5000 + i, b));
      payload.forEach((b, i) => m.memory.writeByte(0x6000 + i, b));
      runStub(m, CAS_WRITE, 0x5000, header.length, 0x2C);
      expect(m.cpu.f & 1).toBe(1);
      runStub(m, CAS_WRITE, 0x6000, payload.length, 0x16);
      expect(m.cpu.f & 1).toBe(1);
      const rec = m.services.tape.recordedBytes!()!;
      m.reset();
      expect(m.services.tape.recordedBytes!()).toBeNull();
      return rec;
    } finally { m.destroy(); }
  }

  it.each(Object.keys(FIRMWARE))('%s: the recording holds the firmware records verbatim', (model) => {
    const rec = save(model);
    expect(rec.filename).toBe('SAVE.cdt');
    const blocks = parseTZX(rec.data).filter((b): b is DataBlock => b.kind === 'data');
    expect(blocks.map(b => Array.from(b.rawBytes!))).toEqual([record(0x2C, header), record(0x16, payload)]);
  });

  it.each(Object.entries(FIRMWARE).flatMap(([model]) => [[model, false], [model, true]] as const))(
    '%s: CAS READ loads the recording back (fast ROM loading %s)', async (model, trap) => {
      const rec = save(model);
      const m = boot(model);
      try {
        m.tapeFastRom = trap;
        expect(await m.services.tape.mountBytes(rec.data, rec.filename)).toBe(true);
        m.services.tape.play();
        runStub(m, CAS_READ, 0x7000, header.length, 0x2C);
        expect(m.cpu.f & 1).toBe(1);
        runStub(m, CAS_READ, 0x8000, payload.length, 0x16);
        expect(m.cpu.f & 1).toBe(1);
        expect(Array.from({ length: header.length }, (_, i) => m.memory.readByte(0x7000 + i))).toEqual(header);
        expect(Array.from({ length: payload.length }, (_, i) => m.memory.readByte(0x8000 + i))).toEqual(payload);
      } finally { m.destroy(); }
    });
});
